import { App } from "obsidian";

import { AUTO_SYNC_FAILURE_THRESHOLD, DEFAULT_FIRST_SYNC_DATE, MAX_PAGE_SIZE, SYNC_SAFETY_LOOKBACK_DAYS } from "../constants";
import { archivePocketNote, upsertPocketNote } from "../notes/upsertNote";
import { buildArchivePath, buildConversationArtifactPath, buildInsightGroupKey, buildInsightPath, findTrackedArtifactPath } from "../notes/pathStrategy";
import { renderConversationArtifactBody, renderConversationArtifactNote } from "../notes/renderConversation";
import { renderInsightNote } from "../notes/renderInsight";
import { PocketApi, PocketApiError } from "../pocket/api";
import { isInsightRecording, matchesTagFilters, normalizeRecordingDetail, normalizeRecordingListItem } from "../pocket/mappers";
import type {
	ConversationArtifactKind,
	NormalizedPocketRecording,
	PocketRecordingListItem,
	PocketSyncSettings,
	PocketTrackedRecord,
	SyncNoteSpec,
	SyncOptions,
	SyncReport,
} from "../types";
import { subtractDays, toPocketDateString } from "../utils/date";
import { SyncStateStore } from "./stateStore";

interface SyncWindow {
	startDate: string;
	endDate: string;
}

interface PendingTrackedRecord {
	recording: NormalizedPocketRecording;
	groupKey: string;
	artifactPaths: string[];
}

const CONVERSATION_ARTIFACT_ORDER: ConversationArtifactKind[] = ["transcript", "summary", "action-items", "mindmap"];

export class SyncService {
	private activeSync: Promise<SyncReport> | null = null;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => PocketSyncSettings,
		private readonly stateStore: SyncStateStore,
	) {}

	async testConnection(): Promise<{ tagCount: number }> {
		const settings = this.getSettings();
		const api = new PocketApi(settings);
		const result = await api.testConnection();
		this.stateStore.recordConnectionSuccess(new Date().toISOString());
		await this.stateStore.persist();
		return result;
	}

	async runSync(options: SyncOptions): Promise<SyncReport> {
		if (this.activeSync) {
			return this.activeSync;
		}

		this.activeSync = this.runSyncInternal(options);

		try {
			return await this.activeSync;
		} finally {
			this.activeSync = null;
		}
	}

	shouldPauseAutoSync(settings: PocketSyncSettings): boolean {
		return settings.pauseAutoSyncAfterFailures && this.stateStore.state.consecutiveFailures >= AUTO_SYNC_FAILURE_THRESHOLD;
	}

	private async updateProgress(message: string): Promise<void> {
		this.stateStore.updateSyncMessage(message);
		if (this.getSettings().verboseSyncLogging) {
			console.debug(`[Pocket Sync] ${message}`);
		}
		await this.stateStore.persist();
	}

	private async runSyncInternal(options: SyncOptions): Promise<SyncReport> {
		const settings = this.getSettings();
		const syncStartedAt = new Date().toISOString();
		const dryRun = options.dryRun ?? false;
		const syncWindow = this.computeSyncWindow(settings, options);
		const report: SyncReport = {
			startedAt: syncStartedAt,
			finishedAt: syncStartedAt,
			scope: options.scope,
			reason: options.reason,
			dryRun,
			created: 0,
			updated: 0,
			skipped: 0,
			archived: 0,
			errors: [],
			warnings: [],
			processedIds: [],
			windowStart: syncWindow.startDate,
			windowEnd: syncWindow.endDate,
		};

		this.stateStore.beginSync(syncStartedAt);

		try {
			if (!settings.apiKey.trim()) {
				throw new PocketApiError("Add a Pocket API key in the Pocket Sync settings before running sync.");
			}

			if (!settings.syncConversations && !settings.syncInsights) {
				report.warnings.push("Both conversation sync and insight sync are disabled.");
				report.finishedAt = new Date().toISOString();
				this.stateStore.completeSync(report);
				await this.stateStore.persist();
				return report;
			}

			await this.updateProgress("Testing Pocket connection.");
			const api = new PocketApi(settings, async (waitMs) => {
				await this.updateProgress(`Pocket API rate limit reached. Waiting ${Math.ceil(waitMs / 1000)} seconds before continuing.`);
			});
			await api.testConnection();
			this.stateStore.recordConnectionSuccess(syncStartedAt);

			await this.updateProgress(`Listing Pocket recordings from ${syncWindow.startDate} to ${syncWindow.endDate}.`);
			const rawRecordings = await api.listAllRecordings({
				startDate: syncWindow.startDate,
				endDate: syncWindow.endDate,
				limit: MAX_PAGE_SIZE,
			});

			await this.updateProgress(`Found ${rawRecordings.length} Pocket recording(s). Preparing sync.`);
			const listItems = rawRecordings
				.map((item) => normalizeRecordingListItem(item))
				.filter((item): item is PocketRecordingListItem => item !== null);
			const seenIds = new Set<string>();
			const recordsToPersist: PocketTrackedRecord[] = [];
			const hydratedRecordings: NormalizedPocketRecording[] = [];

			let detailFetchCount = 0;
			for (const listItem of listItems) {
				if (!this.shouldProcessListItem(listItem, settings, options.scope)) {
					continue;
				}

				if (!matchesTagFilters(listItem, settings)) {
					continue;
				}

				seenIds.add(listItem.id);
				const trackedRecord = this.stateStore.getRecord(listItem.id);

				if (!this.shouldFetchDetails(listItem, trackedRecord, settings, options.forceFullScan ?? false)) {
					if (trackedRecord) {
						recordsToPersist.push({
							...trackedRecord,
							lastSeenAt: syncStartedAt,
							archivedAt: null,
						});
					}
					report.skipped += 1;
					continue;
				}

				try {
					detailFetchCount += 1;
					if (detailFetchCount === 1 || detailFetchCount % 25 === 0) {
						await this.updateProgress(`Fetching Pocket recording details ${detailFetchCount}/${listItems.length}.`);
					}
					const detail = await api.getRecordingDetails(listItem.id, {
						includeTranscript: settings.importTranscriptWhenAvailable && settings.includeTranscript,
						includeSummarizations: true,
					});
					const normalized = normalizeRecordingDetail(detail, listItem, settings);

					if (!normalized) {
						report.warnings.push(`Skipped Pocket recording ${listItem.id} because the details payload was incomplete.`);
						report.skipped += 1;
						continue;
					}

					if (settings.onlyImportCompletedSummaries && normalized.summary?.processingStatus !== "completed") {
						report.skipped += 1;
						report.warnings.push(`Skipped "${normalized.title}" because Pocket has not finished the summary yet.`);
						continue;
					}

					if (!settings.importTranscriptWhenAvailable) {
						normalized.transcript = null;
					}

					hydratedRecordings.push(normalized);
				} catch (error) {
					const message = this.describeError(error);
					report.errors.push(`Failed to fetch Pocket details for "${listItem.title}": ${message}`);
				}
			}

			await this.updateProgress("Rendering Obsidian notes.");
			const noteSpecs = this.buildNoteSpecs(hydratedRecordings, settings);
			const pendingTrackedRecords = new Map<string, PendingTrackedRecord>();
			const processedIds = new Set<string>();
			for (const noteSpec of noteSpecs) {
				const primaryRecording = noteSpec.recordings[0];
				if (!primaryRecording) {
					continue;
				}

				const rendered = noteSpec.kind === "conversation"
					? renderConversationArtifactNote(primaryRecording, settings, syncStartedAt, noteSpec.artifactKind as ConversationArtifactKind)
					: renderInsightNote(noteSpec.recordings, settings, syncStartedAt);
				const result = await upsertPocketNote({
					app: this.app,
					targetPath: noteSpec.targetPath,
					previousPath: noteSpec.previousPath,
					rendered,
					noteManagementMode: settings.noteManagementMode,
					includeFrontmatter: settings.includeFrontmatter,
					dryRun,
				});

				if (result.action === "created") {
					report.created += 1;
				} else if (result.action === "updated") {
					report.updated += 1;
				} else {
					report.skipped += 1;
				}

				this.trackRenderedSpec(pendingTrackedRecords, noteSpec, result.finalPath);
				for (const recording of noteSpec.recordings) {
					processedIds.add(recording.id);
				}
			}

			for (const processedId of processedIds) {
				report.processedIds.push(processedId);
			}

			for (const [recordingId, pendingRecord] of pendingTrackedRecords.entries()) {
				const artifactPaths = Array.from(new Set(pendingRecord.artifactPaths));
				recordsToPersist.push({
					id: recordingId,
					kind: pendingRecord.recording.kind,
					notePath: artifactPaths[0] ?? "",
					artifactPaths,
					groupKey: pendingRecord.groupKey,
					recordingAt: pendingRecord.recording.recordingAt,
					lastSeenAt: syncStartedAt,
					lastSourceUpdatedAt: pendingRecord.recording.updatedAt,
					archivedAt: null,
				});
			}

			if (settings.deletedRecordingBehavior === "archive") {
				await this.updateProgress("Checking for deleted Pocket recordings.");
				const archiveCount = await this.archiveMissingNotes({
					api,
					dryRun,
					report,
					seenIds,
					settings,
					startedAt: syncStartedAt,
					syncWindow,
					scope: options.scope,
				});
				report.archived += archiveCount;
			}

			this.stateStore.upsertRecords(recordsToPersist);
			report.finishedAt = new Date().toISOString();
			this.stateStore.completeSync(report);
			await this.stateStore.persist();
			return report;
		} catch (error) {
			const message = this.describeError(error);
			report.errors.push(message);
			report.finishedAt = new Date().toISOString();
			this.stateStore.failSync(message);
			this.stateStore.state.lastSyncReport = report;
			await this.stateStore.persist();
			return report;
		}
	}

	async createDiagnosticReport(): Promise<string> {
		const settings = this.getSettings();
		const report = this.stateStore.state.lastSyncReport;
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const folder = `${settings.baseFolder}/Diagnostics`;
		const path = `${folder}/Pocket Sync diagnostic ${timestamp}.md`;
		const content = [
			"# Pocket Sync diagnostic report",
			"",
			"## Sync status",
			`- Last sync status: ${this.stateStore.state.lastSyncStatus}`,
			`- Last sync message: ${this.stateStore.state.lastSyncMessage}`,
			`- Last attempted sync: ${this.stateStore.state.lastAttemptedSyncAt ?? "Never"}`,
			`- Last successful sync: ${this.stateStore.state.lastSuccessfulSyncAt ?? "Never"}`,
			`- Last connection success: ${this.stateStore.state.lastConnectionSucceededAt ?? "Never"}`,
			`- Consecutive failures: ${this.stateStore.state.consecutiveFailures}`,
			"",
			"## Settings snapshot",
			`- Auto sync enabled: ${settings.autoSyncEnabled}`,
			`- Sync conversations: ${settings.syncConversations}`,
			`- Sync insights: ${settings.syncInsights}`,
			`- Insights tag: ${settings.insightsTag}`,
			`- Base folder: ${settings.baseFolder}`,
			`- Conversation folder: ${settings.conversationFolder}`,
			`- Insights folder: ${settings.insightsFolder}`,
			`- Note mode: ${settings.noteManagementMode}`,
			"",
			"## Last sync report",
			report
				? [
					`- Started at: ${report.startedAt}`,
					`- Finished at: ${report.finishedAt}`,
					`- Scope: ${report.scope}`,
					`- Reason: ${report.reason}`,
					`- Dry run: ${report.dryRun}`,
					`- Created: ${report.created}`,
					`- Updated: ${report.updated}`,
					`- Skipped: ${report.skipped}`,
					`- Archived: ${report.archived}`,
					`- Window start: ${report.windowStart}`,
					`- Window end: ${report.windowEnd}`,
				].join("\n")
				: "- No sync report is available yet.",
			"",
			"## Notes",
			"- API key intentionally omitted.",
		].join("\n");

		await this.app.vault.adapter.mkdir(folder).catch(() => undefined);
		await this.app.vault.create(path, `${content}\n`);
		return path;
	}

	private async archiveMissingNotes(params: {
		api: PocketApi;
		dryRun: boolean;
		report: SyncReport;
		seenIds: Set<string>;
		settings: PocketSyncSettings;
		startedAt: string;
		syncWindow: SyncWindow;
		scope: SyncOptions["scope"];
	}): Promise<number> {
		const windowStart = Date.parse(`${params.syncWindow.startDate}T00:00:00.000Z`);
		const archivedPaths = new Set<string>();
		const archivePathBySourcePath = new Map<string, string>();
		const recordsToMarkArchived: Array<{ record: PocketTrackedRecord; archivePaths: string[] }> = [];

		for (const trackedRecord of this.stateStore.getTrackedRecords()) {
			if (params.seenIds.has(trackedRecord.id) || trackedRecord.archivedAt) {
				continue;
			}

			if (!this.scopeMatchesKind(params.scope, trackedRecord.kind)) {
				continue;
			}

			if (Date.parse(trackedRecord.recordingAt) < windowStart) {
				continue;
			}

			let allMissing = true;
			try {
				await params.api.getRecordingDetails(trackedRecord.id, {
					includeTranscript: false,
					includeSummarizations: false,
				});
				allMissing = false;
			} catch (error) {
				if (!(error instanceof PocketApiError) || error.status !== 404) {
					allMissing = false;
				}
			}

			if (!allMissing) {
				continue;
			}

			const archivePaths: string[] = [];
			for (const notePath of this.getTrackedPaths(trackedRecord)) {
				const archivePath = buildArchivePath(notePath, params.settings);
				archivePaths.push(archivePath);
				if (archivedPaths.has(notePath)) {
					continue;
				}
				const archived = await archivePocketNote(this.app, notePath, archivePath, params.dryRun);
				if (archived) {
					archivedPaths.add(notePath);
					archivePathBySourcePath.set(notePath, archivePath);
				}
			}
			recordsToMarkArchived.push({ record: trackedRecord, archivePaths });
		}

		for (const { record, archivePaths } of recordsToMarkArchived) {
			this.stateStore.markArchived([record.id], params.startedAt, archivePaths[0] ?? record.notePath, archivePaths);
		}

		const archivedCount = archivePathBySourcePath.size;
		return archivedCount;
	}

	private buildNoteSpecs(recordings: NormalizedPocketRecording[], settings: PocketSyncSettings): SyncNoteSpec[] {
		const noteSpecs: SyncNoteSpec[] = [];
		const insightGroups = new Map<string, NormalizedPocketRecording[]>();

		for (const recording of recordings) {
			if (recording.kind === "conversation") {
				const trackedRecord = this.stateStore.getRecord(recording.id);
				for (const artifactKind of CONVERSATION_ARTIFACT_ORDER) {
					if (!this.shouldRenderConversationArtifact(recording, settings, artifactKind)) {
						continue;
					}

					noteSpecs.push({
						kind: "conversation",
						artifactKind,
						targetPath: buildConversationArtifactPath(this.app.vault, recording, settings, artifactKind, trackedRecord),
						previousPath: findTrackedArtifactPath(trackedRecord, artifactKind),
						groupKey: recording.id,
						trackingIds: [recording.id],
						recordings: [recording],
					});
				}
				continue;
			}

			const groupKey = buildInsightGroupKey(recording, settings.insightMode, settings.insightDateSource);
			const group = insightGroups.get(groupKey) ?? [];
			group.push(recording);
			insightGroups.set(groupKey, group);
		}

		for (const [groupKey, groupedRecordings] of insightGroups.entries()) {
			const trackedRecord =
				groupedRecordings
					.map((recording) => this.stateStore.getRecord(recording.id))
					.find((record): record is PocketTrackedRecord => record !== null) ?? null;
			noteSpecs.push({
				kind: "insight",
				artifactKind: "insight",
				targetPath: buildInsightPath(this.app.vault, groupedRecordings, settings, trackedRecord),
				previousPath: trackedRecord?.notePath ?? null,
				groupKey,
				trackingIds: groupedRecordings.map((recording) => recording.id),
				recordings: groupedRecordings,
			});
		}

		return noteSpecs;
	}

	private shouldRenderConversationArtifact(
		recording: NormalizedPocketRecording,
		settings: PocketSyncSettings,
		artifactKind: ConversationArtifactKind,
	): boolean {
		return renderConversationArtifactBody(recording, settings, artifactKind).trim().length > 0;
	}

	private trackRenderedSpec(
		pendingRecords: Map<string, PendingTrackedRecord>,
		noteSpec: SyncNoteSpec,
		finalPath: string,
	): void {
		for (const recording of noteSpec.recordings) {
			const existing = pendingRecords.get(recording.id);
			if (existing) {
				existing.artifactPaths.push(finalPath);
				continue;
			}

			pendingRecords.set(recording.id, {
				recording,
				groupKey: noteSpec.groupKey,
				artifactPaths: [finalPath],
			});
		}
	}

	private shouldProcessListItem(
		recording: PocketRecordingListItem,
		settings: PocketSyncSettings,
		scope: SyncOptions["scope"],
	): boolean {
		const isInsight = isInsightRecording(recording, settings.insightsTag);
		if (isInsight) {
			return settings.syncInsights && this.scopeMatchesKind(scope, "insight");
		}

		return settings.syncConversations && this.scopeMatchesKind(scope, "conversation");
	}

	private shouldFetchDetails(
		recording: PocketRecordingListItem,
		trackedRecord: PocketTrackedRecord | null,
		settings: PocketSyncSettings,
		forceFullScan: boolean,
	): boolean {
		if (forceFullScan || !trackedRecord) {
			return true;
		}

		if (trackedRecord.archivedAt) {
			return true;
		}

		if (!settings.updateExistingNotes) {
			return false;
		}

		if (trackedRecord.lastSourceUpdatedAt !== recording.updatedAt) {
			return true;
		}

		if (this.getTrackedPaths(trackedRecord).some((path) => !this.app.vault.getAbstractFileByPath(path))) {
			return true;
		}

		return false;
	}

	private computeSyncWindow(settings: PocketSyncSettings, options: SyncOptions): SyncWindow {
		const now = new Date();

		if (options.backfillDays != null) {
			const backfillDays = Math.max(1, Math.min(options.backfillDays, settings.maxDaysPerSyncRun));
			return {
				startDate: toPocketDateString(subtractDays(now, backfillDays)),
				endDate: toPocketDateString(now),
			};
		}

		if (options.forceFullScan) {
			return {
				startDate: DEFAULT_FIRST_SYNC_DATE,
				endDate: toPocketDateString(now),
			};
		}

		if (!this.stateStore.state.lastSuccessfulSyncAt) {
			return {
				startDate: DEFAULT_FIRST_SYNC_DATE,
				endDate: toPocketDateString(now),
			};
		}

		const incrementalStart = subtractDays(new Date(this.stateStore.state.lastSuccessfulSyncAt), SYNC_SAFETY_LOOKBACK_DAYS);
		const maxWindowStart = subtractDays(now, settings.maxDaysPerSyncRun);
		const startDate = incrementalStart < maxWindowStart ? maxWindowStart : incrementalStart;

		return {
			startDate: toPocketDateString(startDate),
			endDate: toPocketDateString(now),
		};
	}

	private scopeMatchesKind(scope: SyncOptions["scope"], kind: NormalizedPocketRecording["kind"]): boolean {
		if (scope === "all") {
			return true;
		}

		if (scope === "conversations") {
			return kind === "conversation";
		}

		return kind === "insight";
	}

	private getTrackedPaths(record: PocketTrackedRecord): string[] {
		return record.artifactPaths.length > 0 ? record.artifactPaths : [record.notePath];
	}

	private describeError(error: unknown): string {
		if (error instanceof PocketApiError) {
			return error.message;
		}

		if (error instanceof Error) {
			return error.message;
		}

		return "Unknown Pocket Sync error.";
	}
}

