/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	ADOSizeComparator,
	type BundleComparison,
	type BundleMetric,
	getAzureDevopsApi,
	totalSizeMetricName,
} from "@fluidframework/bundle-size-tools";
import { Flags } from "@oclif/core";

import { BaseCommand } from "../../library/commands/base.js";

// ADO constants for the baseline build source.
// Must match the "public" project + build-bundle-size-artifacts.yml (definitionId 48).
const adoConstants = {
	orgUrl: "https://dev.azure.com/fluidframework",
	projectName: "public",
	ciBuildDefinitionId: 48,
	bundleAnalysisArtifactName: "bundleAnalysis",
} as const;

// Default path to the PR's locally-collected bundle reports.
// Matches where `flub generate bundleStats` (invoked via `npm run bundle-analysis:collect`) writes.
const defaultLocalReportPath = "./artifacts/bundleAnalysis";

// Default output directory. The pipeline publishes this directory as the `bundleSizeDiff`
// artifact.
const defaultOutputDir = "./artifacts/bundleSizeDiff";

// Any single non-total metric that grows by more than this threshold is considered a
// regression.
const sizeRegressionThresholdBytes = 5120;

/**
 * Shape of the `result.json` file produced by this command.
 *
 * `hasContent` is the single field consumers should read first. When `false`, both
 * `comparison` and `error` are `null`. When `true`, exactly one of `comparison` / `error`
 * is populated.
 */
interface BundleSizeDiffResult {
	prNumber: number;
	baseCommit: string | null;
	targetBranch: string;
	hasContent: boolean;
	sizeRegressionDetected: boolean;
	comparison: BundleComparison[] | null;
	error: string | null;
}

/**
 * Compute whether any bundle shows a non-total metric growing by more than the regression
 * threshold.
 */
function detectSizeRegression(comparison: BundleComparison[]): boolean {
	return comparison.some((bundle: BundleComparison) =>
		Object.entries(bundle.commonBundleMetrics).some(
			([metricName, { baseline, compare }]: [
				string,
				{ baseline: BundleMetric; compare: BundleMetric },
			]) => {
				if (metricName === totalSizeMetricName) {
					return false;
				}
				return compare.parsedSize - baseline.parsedSize > sizeRegressionThresholdBytes;
			},
		),
	);
}

/**
 * Return true when the comparison has no non-zero metric diffs.
 */
function comparisonHasNoChanges(comparison: BundleComparison[]): boolean {
	for (const { commonBundleMetrics } of comparison) {
		for (const { baseline, compare } of Object.values(commonBundleMetrics)) {
			if (baseline.parsedSize !== compare.parsedSize) {
				return false;
			}
		}
	}
	return true;
}

export default class GenerateBundleSizeDiff extends BaseCommand<
	typeof GenerateBundleSizeDiff
> {
	static readonly description =
		`Compare the PR's locally-collected bundle reports against the baseline CI build and write the result as a structured result.json file.`;

	static readonly flags = {
		localReportPath: Flags.directory({
			description: `Path to the locally-collected bundle reports for the PR (as produced by \`flub generate bundleStats\`).`,
			default: defaultLocalReportPath,
			required: false,
		}),
		outputDir: Flags.directory({
			description: `Directory to write the result.json file into.`,
			default: defaultOutputDir,
			required: false,
		}),
		...BaseCommand.flags,
	} as const;

	public async run(): Promise<void> {
		const { flags } = this;

		// Required env vars; failing fast here gives a clearer error than downstream
		// exceptions from the comparator or the result shape.
		const adoApiToken = process.env.ADO_API_TOKEN;
		if (adoApiToken === undefined) {
			this.error("ADO_API_TOKEN env var is required");
		}
		const targetBranchName = process.env.TARGET_BRANCH_NAME;
		if (targetBranchName === undefined) {
			this.error("TARGET_BRANCH_NAME env var is required");
		}
		const prNumberRaw = process.env.PR_NUMBER;
		if (prNumberRaw === undefined) {
			this.error("PR_NUMBER env var is required");
		}
		const prNumber = Number.parseInt(prNumberRaw, 10);
		if (!Number.isFinite(prNumber)) {
			this.error(`PR_NUMBER env var is not a valid number: ${prNumberRaw}`);
		}

		const adoConnection = getAzureDevopsApi(adoApiToken, adoConstants.orgUrl);
		const sizeComparator = new ADOSizeComparator(
			adoConstants,
			adoConnection,
			flags.localReportPath,
			undefined,
			ADOSizeComparator.naiveFallbackCommitGenerator,
		);
		const { comparison, baselineCommit, error } =
			await sizeComparator.getSizeComparison(false);

		let result: BundleSizeDiffResult;
		if (error !== undefined) {
			// Failure to find a usable baseline — set hasContent so consumers surface the
			// error rather than treating it as a no-change result.
			result = {
				prNumber,
				baseCommit: baselineCommit ?? null,
				targetBranch: targetBranchName,
				hasContent: true,
				sizeRegressionDetected: false,
				comparison: null,
				error,
			};
		} else if (comparison === undefined) {
			// Defensive: getSizeComparison's contract is that one of `comparison` / `error`
			// is always set, but guard against an unexpected all-undefined return anyway.
			this.error(
				"getSizeComparison returned no comparison and no error; this should not happen",
			);
		} else if (comparisonHasNoChanges(comparison)) {
			// Zero-delta bundles — emit hasContent=false so consumers treat this as a
			// no-content case.
			result = {
				prNumber,
				baseCommit: baselineCommit ?? null,
				targetBranch: targetBranchName,
				hasContent: false,
				sizeRegressionDetected: false,
				comparison: null,
				error: null,
			};
		} else {
			result = {
				prNumber,
				baseCommit: baselineCommit ?? null,
				targetBranch: targetBranchName,
				hasContent: true,
				sizeRegressionDetected: detectSizeRegression(comparison),
				comparison,
				error: null,
			};
		}

		const outputDir = path.resolve(process.cwd(), flags.outputDir);
		mkdirSync(outputDir, { recursive: true });
		const outputPath = path.join(outputDir, "result.json");
		writeFileSync(outputPath, JSON.stringify(result, undefined, 2));
		this.log(`Wrote ${outputPath}`);
	}
}
