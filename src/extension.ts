import * as vscode from 'vscode';
import { MultiPRTreeProvider, PRBucket } from './treeViewProvider';
import { GitManager } from './gitOperations';

export async function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Multi-PR Manager is now active!');

    const treeDataProvider = new MultiPRTreeProvider();
    const gitManager = new GitManager();

    // Register tree view with drag & drop support
    const treeView = vscode.window.createTreeView('multiPRView', {
        treeDataProvider,
        showCollapseAll: true,
        canSelectMany: true,
        dragAndDropController: treeDataProvider
    });

    // Auto-load git changes when extension activates
    setTimeout(() => {
        treeDataProvider.loadGitChanges();
    }, 1000);

    // Create Bucket Command
    const createBucketCommand = vscode.commands.registerCommand('multiPR.createBucket', async () => {
        const bucketName = await vscode.window.showInputBox({
            prompt: 'Enter bucket name for PR',
            placeHolder: 'e.g., Database Changes, UI Updates, Bug Fixes',
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Bucket name cannot be empty';
                }
                if (treeDataProvider.getBuckets().some(b => b.name === value.trim())) {
                    return 'Bucket with this name already exists';
                }
                return null;
            }
        });

        if (bucketName) {
            const title = await vscode.window.showInputBox({
                prompt: 'Enter PR title',
                value: bucketName.trim(),
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'PR title cannot be empty';
                    }
                    return null;
                }
            });

            if (title) {
                const description = await vscode.window.showInputBox({
                    prompt: 'Enter PR description (optional)',
                    placeHolder: 'Describe the changes in this PR'
                });

                treeDataProvider.createBucket(bucketName.trim(), title.trim(), description?.trim() || '');
                vscode.window.showInformationMessage(`✅ Created bucket: ${bucketName}`);
            }
        }
    });

    // Process All Buckets Command
    const processBucketsCommand = vscode.commands.registerCommand('multiPR.processAll', async () => {
        // Use dependency-aware ordering if available
        const buckets = (treeDataProvider.getBucketsInOrder?.() || treeDataProvider.getBuckets())
            .filter(b => b.files.length > 0);

        if (buckets.length === 0) {
            vscode.window.showWarningMessage('❌ No buckets with files found. Create buckets and drag files into them first.');
            return;
        }

        // Check CLI availability based on repo type
        const config = vscode.workspace.getConfiguration('multiPR');
        const useGitHubCLI = config.get<boolean>('useGitHubCLI', true);
        const repoType = gitManager.getRepoType();

        if (useGitHubCLI && repoType === 'github') {
            try {
                await gitManager.checkCLI();
            } catch (error) {
                const installGH = await vscode.window.showErrorMessage(
                    'GitHub CLI not found. Install it to create PRs without tokens.',
                    'Install GitHub CLI',
                    'Use Manual Method'
                );

                if (installGH === 'Install GitHub CLI') {
                    vscode.env.openExternal(vscode.Uri.parse('https://cli.github.com/'));
                    return;
                } else if (installGH === 'Use Manual Method') {
                    // Continue with manual method
                } else {
                    return;
                }
            }
        } else if (repoType === 'bitbucket') {
            // Bitbucket will use manual PR creation URLs
            try {
                await gitManager.checkCLI();
            } catch (error) {
                // Continue - Bitbucket doesn't require CLI
            }
        } else if (repoType === 'unknown') {
            vscode.window.showWarningMessage('Unknown repository type. Only GitHub and Bitbucket are supported.');
            return;
        }

        // Build a preview of what will happen per bucket
        const defaultBaseBranch = config.get<string>('defaultBaseBranch', 'main');
        const bucketByName: Record<string, PRBucket> = Object.fromEntries(buckets.map(b => [b.name, b]));
        const previewLines: string[] = [];
        previewLines.push(`# Multi-PR Plan Preview`);
        previewLines.push('');
        previewLines.push(`Repository type: ${repoType}`);
        previewLines.push(`Default base branch: ${defaultBaseBranch}`);
        previewLines.push('');
        for (const b of buckets) {
            const dependsOn: string | undefined = (b as any)?.dependsOn;
            const baseBranch = dependsOn ? (bucketByName[dependsOn]?.branchName || defaultBaseBranch) : defaultBaseBranch;
            previewLines.push(`## ${b.name}`);
            previewLines.push(`- Base branch: ${baseBranch}`);
            if (dependsOn) previewLines.push(`- Depends on: ${dependsOn}`);
            previewLines.push(`- Files (${b.files.length}):`);
            for (const f of b.files) {
                previewLines.push(`  - ${f.path} (${f.status})`);
            }
            previewLines.push('');
        }

        const previewDoc = await vscode.workspace.openTextDocument({ language: 'markdown', content: previewLines.join('\n') });
        await vscode.window.showTextDocument(previewDoc, { preview: true });

        const proceed = await vscode.window.showInformationMessage(
            `🎯 Ready to create ${buckets.length} PRs. Preview opened. Proceed?`,
            'Yes, Create PRs',
            'Cancel'
        );

        if (proceed !== 'Yes, Create PRs') return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Creating Multiple PRs',
            cancellable: false
        }, async (progress) => {
            const results = [];
            const totalSteps = buckets.length * 4; // 4 steps per bucket
            let currentStep = 0;

            try {
                const originalBranch = await gitManager.getCurrentBranch();
                const defaultBaseBranch = config.get<string>('defaultBaseBranch', 'main');
                const bucketByName: Record<string, PRBucket> = Object.fromEntries(buckets.map(b => [b.name, b]));

                for (const bucket of buckets) {
                    // Determine base branch: if this bucket depends on another, base off that bucket's branch
                    const baseBranch = (bucket as any)?.dependsOn
                        ? (bucketByName[(bucket as any).dependsOn]?.branchName || defaultBaseBranch)
                        : defaultBaseBranch;
                    // Step 1: Create branch
                    progress.report({
                        increment: (currentStep++ / totalSteps) * 100,
                        message: `Creating branch for ${bucket.name}...`
                    });

                    const branchName = await gitManager.createBranchForBucket(bucket.name, baseBranch);
                    bucket.branchName = branchName;

                    // Step 2: Stage files
                    progress.report({
                        increment: (currentStep++ / totalSteps) * 100,
                        message: `Staging files for ${bucket.name}...`
                    });

                    await gitManager.stageFilesForBucket(bucket);

                    // Step 3: Commit
                    progress.report({
                        increment: (currentStep++ / totalSteps) * 100,
                        message: `Committing ${bucket.name}...`
                    });

                    await gitManager.commitBucket(bucket);

                    // Step 4: Push
                    progress.report({
                        increment: (currentStep++ / totalSteps) * 100,
                        message: `Pushing ${bucket.name}...`
                    });

                    await gitManager.pushBranch(branchName);

                    // Create PR
                    if (useGitHubCLI || gitManager.getRepoType() === 'bitbucket') {
                        try {
                            const prUrl = await gitManager.createPRWithCLI(bucket, baseBranch);
                            results.push({
                                bucketName: bucket.name,
                                branchName,
                                url: prUrl,
                                success: true,
                                manual: gitManager.getRepoType() === 'bitbucket'
                            });
                        } catch (error) {
                            results.push({
                                bucketName: bucket.name,
                                branchName,
                                error: String(error),
                                success: false
                            });
                        }
                    } else {
                        // Manual PR creation for GitHub without CLI
                        const repoUrl = await gitManager.getRepositoryUrl();
                        const prUrl = `${repoUrl}/compare/${branchName}`;
                        results.push({
                            bucketName: bucket.name,
                            branchName,
                            url: prUrl,
                            success: true,
                            manual: true
                        });
                    }
                }

                // Switch back to original branch
                await gitManager.switchToBranch(originalBranch);

                // Show results
                const successCount = results.filter(r => r.success).length;
                const failureCount = results.length - successCount;

                if (successCount > 0) {
                    const repoTypeName = repoType === 'github' ? 'GitHub' : repoType === 'bitbucket' ? 'Bitbucket' : 'repository';
                    const hasManualPRs = results.some(r => r.success && r.manual);
                    
                    const message = (useGitHubCLI && repoType === 'github' && !hasManualPRs) ? 
                        `✅ Successfully created ${successCount} PRs on ${repoTypeName}!` :
                        `✅ Created ${successCount} branches! Click to open ${repoTypeName} and create PRs.`;

                    const action = await vscode.window.showInformationMessage(
                        message,
                        'View Results',
                        `Open ${repoTypeName}`
                    );

                    if (action === 'View Results' || action === `Open ${repoTypeName}`) {
                        for (const result of results.filter(r => r.success)) {
                            vscode.env.openExternal(vscode.Uri.parse(result?.url || 'https://cli.github.com/'));
                        }
                    }
                }

                if (failureCount > 0) {
                    const errors = results.filter(r => !r.success).map(r => 
                        `• ${r.bucketName}: ${r.error}`
                    ).join('\n');

                    vscode.window.showErrorMessage(`❌ ${failureCount} PRs failed:\n${errors}`);
                }

                // Clear buckets after successful creation
                if (successCount > 0) {
                    treeDataProvider.clearBuckets();
                }

            } catch (error) {
                vscode.window.showErrorMessage(`❌ Error creating PRs: ${error}`);
            }
        });
    });

    // Refresh Command
    const refreshCommand = vscode.commands.registerCommand('multiPR.refresh', async () => {
        await treeDataProvider.loadGitChanges();
        vscode.window.showInformationMessage('🔄 Git changes refreshed!');
    });

    // Delete Bucket Command
    const deleteBucketCommand = vscode.commands.registerCommand('multiPR.deleteBucket', (bucket: PRBucket) => {
        treeDataProvider.deleteBucket(bucket);
        vscode.window.showInformationMessage(`🗑️ Deleted bucket: ${bucket.name}`);
    });

    // Open Settings Command
    const openSettingsCommand = vscode.commands.registerCommand('multiPR.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', 'multiPR');
    });

    // Set Dependency Command
    const setDependencyCommand = vscode.commands.registerCommand('multiPR.setDependency', async (bucket: PRBucket) => {
        try {
            const allBuckets = treeDataProvider.getBuckets();
            const otherNames = allBuckets.map(b => b.name).filter(n => n !== bucket.name);
            const picks = ['None', ...otherNames];
            const choice = await vscode.window.showQuickPick(picks, {
                placeHolder: 'Select the bucket this one depends on (or None)'
            });
            if (choice === undefined) { return; }
            const dependsOn = choice === 'None' ? undefined : choice;
            (treeDataProvider as any).setBucketDependency?.(bucket.name, dependsOn);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to set dependency: ${e}`);
        }
    });

    // Preview Bucket Command
    const previewBucketCommand = vscode.commands.registerCommand('multiPR.previewBucket', async (bucket?: PRBucket) => {
        const config = vscode.workspace.getConfiguration('multiPR');
        const defaultBaseBranch = config.get<string>('defaultBaseBranch', 'main');
        const allBuckets = (treeDataProvider.getBucketsInOrder?.() || treeDataProvider.getBuckets());
        if (!bucket) {
            // Invoked from title or without context: ask user to pick a bucket
            const pickedName = await vscode.window.showQuickPick(allBuckets.map(b => b.name), {
                placeHolder: 'Select a bucket to preview'
            });
            if (!pickedName) { return; }
            bucket = allBuckets.find(b => b.name === pickedName);
            if (!bucket) { return; }
        }

        const byName: Record<string, PRBucket> = Object.fromEntries(allBuckets.map(b => [b.name, b]));
        const dependsOn: string | undefined = (bucket as any)?.dependsOn;
        const baseBranch = dependsOn ? (byName[dependsOn]?.branchName || defaultBaseBranch) : defaultBaseBranch;

        const files = bucket.files || [];
        const lines: string[] = [];
        lines.push(`# Preview: ${bucket.name}`);
        lines.push('');
        lines.push(`- Title: ${bucket.title}`);
        lines.push(`- Description: ${bucket.description || '(none)'}`);
        if (dependsOn) { lines.push(`- Depends on: ${dependsOn}`); }
        lines.push(`- Base branch: ${baseBranch}`);
        lines.push(`- Files (${files.length}):`);
        for (const f of files) {
            lines.push(`  - ${f.path} (${f.status})`);
        }
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
        await vscode.window.showTextDocument(doc, { preview: true });
    });

    context.subscriptions.push(
        treeView,
        createBucketCommand,
        processBucketsCommand,
        refreshCommand,
        deleteBucketCommand,
        openSettingsCommand,
        setDependencyCommand,
        previewBucketCommand
    );

    // Show welcome message
    vscode.window.showInformationMessage(
        '🎉 Multi-PR Manager activated! Check the Source Control panel to get started.',
        'Got it!'
    );
}

export function deactivate() {}