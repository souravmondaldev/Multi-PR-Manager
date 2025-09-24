import { execSync } from 'child_process';
import * as vscode from 'vscode';
import * as path from 'path';
import { PRBucket } from './treeViewProvider';

export class GitManager {
    private workspaceRoot: string;
    private repoType: 'github' | 'bitbucket' | 'unknown' = 'unknown';

    constructor() {
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        this.detectRepoType();
    }

    private detectRepoType(): void {
        try {
            const remoteUrl = execSync('git config --get remote.origin.url', { 
                cwd: this.workspaceRoot, 
                encoding: 'utf8' 
            }).trim();

            if (remoteUrl.includes('github.com')) {
                this.repoType = 'github';
            } else if (remoteUrl.includes('bitbucket.org')) {
                this.repoType = 'bitbucket';
            } else {
                this.repoType = 'unknown';
            }
        } catch (error) {
            this.repoType = 'unknown';
        }
    }

    getRepoType(): 'github' | 'bitbucket' | 'unknown' {
        return this.repoType;
    }

    async checkCLI(): Promise<void> {
        if (this.repoType === 'github') {
            return this.checkGitHubCLI();
        } else if (this.repoType === 'bitbucket') {
            return this.checkBitbucketCLI();
        } else {
            throw new Error('Unsupported repository type. Only GitHub and Bitbucket are supported.');
        }
    }

    private async checkGitHubCLI(): Promise<void> {
        try {
            execSync('gh --version', { stdio: 'ignore' });

            // Check if logged in
            try {
                execSync('gh auth status', { stdio: 'ignore' });
            } catch {
                throw new Error('GitHub CLI found but not authenticated. Run: gh auth login');
            }
        } catch (error) {
            throw new Error('GitHub CLI not found. Install from: https://cli.github.com/');
        }
    }

    private async checkBitbucketCLI(): Promise<void> {
        // For Bitbucket, we'll use git commands and provide manual PR creation URLs
        // Bitbucket doesn't have a widely adopted CLI like GitHub
        return Promise.resolve();
    }

    async getCurrentBranch(): Promise<string> {
        try {
            const branch = execSync('git branch --show-current', { 
                cwd: this.workspaceRoot, 
                encoding: 'utf8' 
            }).trim();
            return branch;
        } catch (error) {
            throw new Error(`Failed to get current branch: ${error}`);
        }
    }

    async getRepositoryUrl(): Promise<string> {
        try {
            const remoteUrl = execSync('git config --get remote.origin.url', { 
                cwd: this.workspaceRoot, 
                encoding: 'utf8' 
            }).trim();

            // Convert SSH to HTTPS for browser opening
            if (remoteUrl.startsWith('git@github.com:')) {
                return remoteUrl.replace('git@github.com:', 'https://github.com/').replace('.git', '');
            } else if (remoteUrl.startsWith('git@bitbucket.org:')) {
                return remoteUrl.replace('git@bitbucket.org:', 'https://bitbucket.org/').replace('.git', '');
            } else if (remoteUrl.includes('github.com')) {
                return remoteUrl.replace('.git', '');
            } else if (remoteUrl.includes('bitbucket.org')) {
                return remoteUrl.replace('.git', '');
            }

            return remoteUrl;
        } catch (error) {
            throw new Error(`Failed to get repository URL: ${error}`);
        }
    }

    async stageFilesForBucket(bucket: PRBucket): Promise<void> {
        if (!this.workspaceRoot || bucket.files.length === 0) return;

        try {
            // Unstage everything first to ensure isolation
            execSync('git reset', { cwd: this.workspaceRoot });

            // Stage each file individually to handle spaces and special characters
            for (const file of bucket.files) {
                const fullPath = path.join(this.workspaceRoot, file.path);
                // For deletions, 'git add' won't stage removed files. Use git rm when needed.
                if (file.status === 'Deleted' || file.gitStatus === 'D') {
                    try {
                        execSync(`git rm -f --ignore-unmatch "${file.path}"`, { cwd: this.workspaceRoot });
                    } catch {
                        // If the file wasn't tracked, ignore
                    }
                } else {
                    const cmd = `git add "${file.path}"`;
                    execSync(cmd, { cwd: this.workspaceRoot });
                }
            }
        } catch (error) {
            throw new Error(`Failed to stage files for ${bucket.name}: ${error}`);
        }
    }

    async createBranchForBucket(bucketName: string, baseBranch?: string): Promise<string> {
        if (!this.workspaceRoot) {
            throw new Error('No workspace root found');
        }

        try {
            // Create a sanitized branch name
            const sanitized = bucketName.toLowerCase()
                .replace(/[^a-z0-9\s]/g, '') // Remove special chars except spaces
                .replace(/\s+/g, '-') // Replace spaces with dashes
                .replace(/^-+|-+$/g, '') // Remove leading/trailing dashes
                .substring(0, 40); // Limit length

            const timestamp = Date.now().toString().slice(-6); // Last 6 digits
            const branchName = `feature/${sanitized}-${timestamp}`;

            // If a base branch is provided, switch to it first to branch off correctly
            if (baseBranch && baseBranch.trim().length > 0) {
                try {
                    execSync(`git checkout "${baseBranch}"`, { cwd: this.workspaceRoot });
                    // Ensure it's up to date (best-effort, ignore failures for non-tracking branches)
                    try { execSync(`git pull --ff-only`, { cwd: this.workspaceRoot, stdio: 'ignore' }); } catch {}
                } catch (error) {
                    // If checkout fails, proceed from current HEAD
                }
            }

            // Create and checkout new branch off the current HEAD
            execSync(`git checkout -b "${branchName}"`, { cwd: this.workspaceRoot });

            return branchName;
        } catch (error) {
            throw new Error(`Failed to create branch for ${bucketName}: ${error}`);
        }
    }

    async commitBucket(bucket: PRBucket): Promise<void> {
        if (!this.workspaceRoot) return;

        try {
            // Create a proper commit message
            const filesList = bucket.files.map(f => `- ${f.path}`).join('\n');

            const commitMessage = `${bucket.title}

${bucket.description ? bucket.description + '\n\n' : ''}Files modified:
${filesList}`;

            // Use -m flag to avoid issues with multiline messages
            const tempFile = require('path').join(this.workspaceRoot, '.git', 'COMMIT_EDITMSG_TEMP');
            require('fs').writeFileSync(tempFile, commitMessage, 'utf8');

            execSync(`git commit -F "${tempFile}"`, { cwd: this.workspaceRoot });

            // Clean up temp file
            try {
                require('fs').unlinkSync(tempFile);
            } catch {} // Ignore cleanup errors

        } catch (error) {
            throw new Error(`Failed to commit ${bucket.name}: ${error}`);
        }
    }

    async pushBranch(branchName: string): Promise<void> {
        if (!this.workspaceRoot) return;

        try {
            // Push branch to origin
            execSync(`git push -u origin "${branchName}"`, { 
                cwd: this.workspaceRoot,
                stdio: 'ignore' // Suppress git push output
            });
        } catch (error) {
            throw new Error(`Failed to push branch ${branchName}: ${error}`);
        }
    }

    async switchToBranch(branchName: string): Promise<void> {
        if (!this.workspaceRoot) return;

        try {
            execSync(`git checkout "${branchName}"`, { cwd: this.workspaceRoot });
        } catch (error) {
            throw new Error(`Failed to switch to branch ${branchName}: ${error}`);
        }
    }

    async createPRWithCLI(bucket: PRBucket, baseBranch: string): Promise<string> {
        if (!this.workspaceRoot || !bucket.branchName) {
            throw new Error('Invalid bucket or branch name');
        }

        if (this.repoType === 'github') {
            return this.createGitHubPR(bucket, baseBranch);
        } else if (this.repoType === 'bitbucket') {
            return this.createBitbucketPR(bucket, baseBranch);
        } else {
            throw new Error('Unsupported repository type for PR creation');
        }
    }

    private async createGitHubPR(bucket: PRBucket, baseBranch: string): Promise<string> {
        try {
            // baseBranch is already resolved by caller

            // Create PR using GitHub CLI
            const cmd = `gh pr create --title "${bucket.title}" --body "${bucket.description}" --base "${baseBranch}" --head "${bucket.branchName}"`;

            const output = execSync(cmd, { 
                cwd: this.workspaceRoot,
                encoding: 'utf8'
            });

            // Extract PR URL from output
            const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
            if (urlMatch) {
                return urlMatch[0];
            }

            // Fallback: construct URL
            const repoUrl = await this.getRepositoryUrl();
            return `${repoUrl}/pulls`;

        } catch (error) {
            throw new Error(`Failed to create GitHub PR: ${error}`);
        }
    }

    private async createBitbucketPR(bucket: PRBucket, baseBranch: string): Promise<string> {
        // For Bitbucket, we'll return the URL to create PR manually
        // since Bitbucket doesn't have a widely adopted CLI
        try {
            const repoUrl = await this.getRepositoryUrl();
            
            // Construct Bitbucket PR creation URL
            const prUrl = `${repoUrl}/pull-requests/new?source=${encodeURIComponent(bucket.branchName!)}&dest=${encodeURIComponent(baseBranch)}&title=${encodeURIComponent(bucket.title)}&description=${encodeURIComponent(bucket.description)}`;
            
            return prUrl;
        } catch (error) {
            throw new Error(`Failed to create Bitbucket PR URL: ${error}`);
        }
    }
}