import * as vscode from 'vscode';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';



// export interface FileItem {
//     path: string;
//     status: string;
//     label: string;
// }
export interface FileItem {
    path: string;    // full relative path from workspace
    status: string;
    label: string;
    isDirectory?: boolean;
    size?: number;
    lastModified?: Date;
    gitStatus?: string;  // M, A, D, R, C, ??
}


export interface PRBucket {
    name: string;
    title: string;
    description: string;
    files: FileItem[];
    branchName?: string;
    dependsOn?: string; // Name of bucket this depends on
    order?: number; // Order for processing dependencies
}

export class MultiPRTreeProvider implements vscode.TreeDataProvider<PRBucket | FileItem | WelcomeItem>, vscode.TreeDragAndDropController<PRBucket | FileItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PRBucket | FileItem | WelcomeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private buckets: PRBucket[] = [];
    private gitChanges: FileItem[] = [];
    private workspaceRoot: string;
    private isGitRepo: boolean = false;

    // Drag and drop support
    dropMimeTypes = ['application/vnd.code.tree.multiprview'];
    dragMimeTypes = ['application/vnd.code.tree.multiprview'];

    constructor() {
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        this.checkGitRepository();
    }

    private checkGitRepository(): void {
        try {
            if (this.workspaceRoot) {
                execSync('git rev-parse --git-dir', {
                    cwd: this.workspaceRoot,
                    stdio: 'ignore'
                });
                this.isGitRepo = true;
            }
        } catch (error) {
            this.isGitRepo = false;
        }
    }

    async loadGitChanges(): Promise<void> {
        try {
            if (!this.workspaceRoot) {
                this.gitChanges = [];
                this.refresh();
                return;
            }

            if (!this.isGitRepo) {
                this.gitChanges = [];
                this.refresh();
                return;
            }

            // Get git status
            const output = execSync('git status --porcelain', {
                cwd: this.workspaceRoot,
                encoding: 'utf8'
            });

            this.gitChanges = output
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => {
                    const status = line.substring(0, 2).trim();
                    let filePath = line.substring(3);

                    // Normalize paths and detect directory markers from git (e.g., '?? src/')
                    const hasTrailingSlash = filePath.endsWith('/') || filePath.endsWith('\\');
                    if (hasTrailingSlash) {
                        filePath = filePath.replace(/[\\/]+$/g, '');
                    }

                    const fullPath = path.join(this.workspaceRoot, filePath);
                    let size: number | undefined;
                    let lastModified: Date | undefined;
                    let isDir = false;
                    
                    try {
                        const stats = fs.statSync(fullPath);
                        isDir = stats.isDirectory();
                        if (!isDir) {
                            size = stats.size;
                            lastModified = stats.mtime;
                        }
                    } catch (error) {
                        // File might be deleted or inaccessible; best-effort detection based on trailing slash
                        isDir = hasTrailingSlash;
                    }

                    // Skip pure directory entries; we will derive folders from file paths
                    if (isDir) {
                        return null as any;
                    }

                    return {
                        path: filePath,
                        status: this.getStatusLabel(status),
                        label: filePath, // show full relative path like src/model/model.ts
                        gitStatus: status,
                        size,
                        lastModified,
                        isDirectory: false
                    } as FileItem;
                })
                .filter((file: FileItem | null) => !!file)
                .filter((file: FileItem) => !this.isFileInBucket(file.path)) as FileItem[];

            this.refresh();
        } catch (error) {
            console.error('Error loading git changes:', error);
            this.gitChanges = [];
            this.refresh();
        }
    }

    private isFileInBucket(filePath: string): boolean {
        return this.buckets.some(bucket =>
            bucket.files.some(file => file.path === filePath)
        );
    }

    private getStatusLabel(status: string): string {
        switch (status) {
            case 'M': return 'Modified';
            case 'A': return 'Added';
            case 'D': return 'Deleted';
            case 'R': return 'Renamed';
            case 'C': return 'Copied';
            case '??': return 'Untracked';
            default: return 'Changed';
        }
    }

    createBucket(name: string, title: string, description: string): void {
        this.buckets.push({
            name,
            title,
            description,
            files: []
        });
        this.refresh();
    }

    deleteBucket(bucket: PRBucket): void {
        const index = this.buckets.indexOf(bucket);
        if (index > -1) {
            // Move files back to git changes
            bucket.files.forEach(file => {
                if (!this.gitChanges.find(f => f.path === file.path)) {
                    this.gitChanges.push(file);
                }
            });

            this.buckets.splice(index, 1);
            this.refresh();
        }
    }

    getBuckets(): PRBucket[] {
        return this.buckets;
    }

    clearBuckets(): void {
        this.buckets = [];
        this.loadGitChanges();
    }

    setBucketDependency(bucketName: string, dependsOn: string | undefined): void {
        const bucket = this.buckets.find(b => b.name === bucketName);
        if (bucket) {
            bucket.dependsOn = dependsOn;
            this.updateBucketOrder();
            this.refresh();
        }
    }

    private updateBucketOrder(): void {
        // Topological sort to determine processing order
        const visited = new Set<string>();
        const visiting = new Set<string>();
        const order: string[] = [];

        const visit = (bucketName: string): boolean => {
            if (visiting.has(bucketName)) {
                // Circular dependency detected
                return false;
            }
            if (visited.has(bucketName)) {
                return true;
            }

            visiting.add(bucketName);
            const bucket = this.buckets.find(b => b.name === bucketName);
            if (bucket?.dependsOn) {
                if (!visit(bucket.dependsOn)) {
                    return false;
                }
            }
            visiting.delete(bucketName);
            visited.add(bucketName);
            order.push(bucketName);
            return true;
        };

        // Visit all buckets
        for (const bucket of this.buckets) {
            if (!visited.has(bucket.name)) {
                if (!visit(bucket.name)) {
                    // Handle circular dependency by removing it
                    vscode.window.showWarningMessage(`Circular dependency detected involving ${bucket.name}. Dependency removed.`);
                    bucket.dependsOn = undefined;
                    this.updateBucketOrder();
                    return;
                }
            }
        }

        // Assign order numbers
        order.forEach((bucketName, index) => {
            const bucket = this.buckets.find(b => b.name === bucketName);
            if (bucket) {
                bucket.order = index;
            }
        });
    }

    getBucketsInOrder(): PRBucket[] {
        return [...this.buckets].sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PRBucket | FileItem | WelcomeItem): vscode.TreeItem {
        if ('isWelcome' in element) {
            // Welcome item
            const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
            treeItem.description = element.description;
            treeItem.tooltip = element.tooltip;
            treeItem.iconPath = new vscode.ThemeIcon(element.icon);
            if (element.command) {
                treeItem.command = element.command;
            }
            return treeItem;
        } else if ('files' in element) {
            // This is a PRBucket
            const dependencyText = element.dependsOn ? ` → ${element.dependsOn}` : '';
            const orderText = element.order !== undefined ? ` [${element.order + 1}]` : '';
            
            const treeItem = new vscode.TreeItem(
                `${element.name}${orderText} (${element.files.length} files)${dependencyText}`,
                element.files.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
            );
            treeItem.contextValue = 'bucket';
            
            // Use different icon colors based on dependency status
            const iconColor = element.dependsOn ? 
                new vscode.ThemeColor('charts.orange') : 
                new vscode.ThemeColor('charts.blue');
            treeItem.iconPath = new vscode.ThemeIcon('folder-opened', iconColor);
            
            let tooltip = `${element.title}\n${element.description || 'No description'}\n\nFiles: ${element.files.length}`;
            if (element.dependsOn) {
                tooltip += `\nDepends on: ${element.dependsOn}`;
            }
            if (element.order !== undefined) {
                tooltip += `\nProcessing order: ${element.order + 1}`;
            }
            treeItem.tooltip = tooltip;
            return treeItem;
        }
        else if ('isDirectory' in element && element.isDirectory) {
            const treeItem = new vscode.TreeItem(
                element.label,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            treeItem.contextValue = 'folder';
            treeItem.resourceUri = vscode.Uri.file(path.join(this.workspaceRoot, element.path));
            treeItem.iconPath = vscode.ThemeIcon.Folder;
            treeItem.tooltip = `Folder: ${element.path}`;
            return treeItem;
        }
        else {
            // This is a FileItem
            const treeItem = new vscode.TreeItem(
                element.label,
                vscode.TreeItemCollapsibleState.None
            );
            treeItem.contextValue = 'file';
            treeItem.resourceUri = vscode.Uri.file(path.join(this.workspaceRoot, element.path));
            
            // Get proper file icon based on file extension
            const fileExtension = path.extname(element.path).toLowerCase();
            let iconName = 'file';
            
            // Map common file extensions to appropriate icons
            const iconMap: { [key: string]: string } = {
                '.js': 'file-code',
                '.ts': 'file-code',
                '.jsx': 'file-code',
                '.tsx': 'file-code',
                '.py': 'file-code',
                '.java': 'file-code',
                '.cpp': 'file-code',
                '.c': 'file-code',
                '.cs': 'file-code',
                '.php': 'file-code',
                '.rb': 'file-code',
                '.go': 'file-code',
                '.rs': 'file-code',
                '.html': 'file-code',
                '.css': 'file-code',
                '.scss': 'file-code',
                '.less': 'file-code',
                '.json': 'json',
                '.xml': 'file-code',
                '.yaml': 'file-code',
                '.yml': 'file-code',
                '.md': 'markdown',
                '.txt': 'file-text',
                '.pdf': 'file-pdf',
                '.png': 'file-media',
                '.jpg': 'file-media',
                '.jpeg': 'file-media',
                '.gif': 'file-media',
                '.svg': 'file-media',
                '.ico': 'file-media',
                '.zip': 'file-zip',
                '.tar': 'file-zip',
                '.gz': 'file-zip',
                '.sql': 'database',
                '.db': 'database'
            };
            
            iconName = iconMap[fileExtension] || 'file';
            
            // Add color based on git status
            const statusColors = {
                'Modified': new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
                'Added': new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
                'Deleted': new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
                'Untracked': new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
                'Renamed': new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
                'Copied': new vscode.ThemeColor('gitDecoration.addedResourceForeground')
            };

            if (statusColors[element.status as keyof typeof statusColors]) {
                treeItem.iconPath = new vscode.ThemeIcon(iconName, statusColors[element.status as keyof typeof statusColors]);
            } else {
                treeItem.iconPath = new vscode.ThemeIcon(iconName);
            }
            
            // Enhanced tooltip with file information
            let tooltip = `${element.path} (${element.status})`;
            if (element.size !== undefined) {
                const sizeStr = element.size < 1024 ? `${element.size} B` : 
                               element.size < 1024 * 1024 ? `${(element.size / 1024).toFixed(1)} KB` :
                               `${(element.size / (1024 * 1024)).toFixed(1)} MB`;
                tooltip += `\nSize: ${sizeStr}`;
            }
            if (element.lastModified) {
                tooltip += `\nModified: ${element.lastModified.toLocaleString()}`;
            }
            
            treeItem.tooltip = tooltip;
            treeItem.description = element.status;
            
            // Add command to open preview for images, diff for text
            const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp', '.webp']);
            if (imageExts.has(fileExtension)) {
                treeItem.command = {
                    command: 'vscode.open',
                    title: 'Open Preview',
                    arguments: [vscode.Uri.file(path.join(this.workspaceRoot, element.path))]
                };
            } else {
                treeItem.command = {
                    command: 'vscode.diff',
                    title: 'Open Diff',
                    arguments: [
                        vscode.Uri.parse(`git:${element.path}?HEAD`),
                        vscode.Uri.file(path.join(this.workspaceRoot, element.path)),
                        `${element.label} (Working Tree)`
                    ]
                };
            }

            return treeItem;
        }
    }

    // getChildren(element?: PRBucket | FileItem | WelcomeItem): Thenable<(PRBucket | FileItem | WelcomeItem)[]> {
    //     if (!element) {
    //         // Root level
    //         if (!this.workspaceRoot) {
    //             return Promise.resolve([
    //                 {
    //                     isWelcome: true,
    //                     label: 'No Workspace',
    //                     description: 'Open a folder to get started',
    //                     tooltip: 'Open a folder containing a Git repository',
    //                     icon: 'folder-opened',
    //                     command: {
    //                         command: 'vscode.openFolder',
    //                         title: 'Open Folder'
    //                     }
    //                 } as WelcomeItem
    //             ]);
    //         }

    //         if (!this.isGitRepo) {
    //             return Promise.resolve([
    //                 {
    //                     isWelcome: true,
    //                     label: 'Not a Git Repository',
    //                     description: 'Initialize Git or open a Git repository',
    //                     tooltip: 'This folder is not a Git repository',
    //                     icon: 'source-control'
    //                 } as WelcomeItem
    //             ]);
    //         }

    //         const items: (PRBucket | FileItem | WelcomeItem)[] = [];

    //         // Add buckets
    //         items.push(...this.buckets);

    //         // Add separator if we have both buckets and files
    //         if (this.buckets.length > 0 && this.gitChanges.length > 0) {
    //             items.push({
    //                 isWelcome: true,
    //                 label: '── Available Files ──',
    //                 description: 'Drag files into buckets above',
    //                 tooltip: 'Files changed in your working directory',
    //                 icon: 'files'
    //             } as WelcomeItem);
    //         }

    //         // Add git changes
    //         items.push(...this.gitChanges);

    //         // Add welcome message if no changes
    //         if (this.buckets.length === 0 && this.gitChanges.length === 0) {
    //             items.push({
    //                 isWelcome: true,
    //                 label: 'No Changes Found',
    //                 description: 'Make some changes and click refresh',
    //                 tooltip: 'No modified files detected in the working directory',
    //                 icon: 'check',
    //                 command: {
    //                     command: 'multiPR.refresh',
    //                     title: 'Refresh'
    //                 }
    //             } as WelcomeItem);
    //         }

    //         return Promise.resolve(items);
    //     } else if ('files' in element) {
    //         // This is a bucket, show its files
    //         const items: (FileItem | WelcomeItem)[] = [...element.files];

    //         if (element.files.length === 0) {
    //             items.push({
    //                 isWelcome: true,
    //                 label: 'Empty bucket',
    //                 description: 'Drag files here',
    //                 tooltip: 'This bucket has no files. Drag files from the git changes below.',
    //                 icon: 'arrow-down'
    //             } as WelcomeItem);
    //         }

    //         return Promise.resolve(items);
    //     } else {
    //         // File or welcome item - no children
    //         return Promise.resolve([]);
    //     }
    // }
    private getFilesAndFoldersAtLevel(files: FileItem[], currentPath: string = ''): FileItem[] {
        const map = new Map<string, FileItem>();
        const currentDepth = currentPath ? currentPath.split(path.sep).length : 0;

        for (const file of files) {
            const segments = file.path.split(path.sep);
            
            // If we're at root level, show all files and first-level folders
            if (currentPath === '') {
                if (segments.length === 1) {
                    // Top-level file
                    map.set(file.path, file);
                } else {
                    // First-level folder
                    const folderName = segments[0];
                    if (!map.has(folderName)) {
                        map.set(folderName, {
                            path: folderName,
                            label: folderName,
                            status: '',
                            isDirectory: true
                        });
                    }
                }
            } else {
                // We're inside a folder, show files and subfolders at this level
                if (file.path.startsWith(currentPath + path.sep)) {
                    const relativePath = file.path.substring(currentPath.length + 1);
                    const relativeSegments = relativePath.split(path.sep);
                    
                    if (relativeSegments.length === 1) {
                        // Direct file in this folder
                        map.set(file.path, file);
                    } else {
                        // Subfolder
                        const subfolderName = relativeSegments[0];
                        const subfolderPath = path.join(currentPath, subfolderName);
                        if (!map.has(subfolderPath)) {
                            map.set(subfolderPath, {
                                path: subfolderPath,
                                label: subfolderName,
                                status: '',
                                isDirectory: true
                            });
                        }
                    }
                }
            }
        }
        return Array.from(map.values());
    }
    getChildren(element?: PRBucket | FileItem | WelcomeItem): Thenable<(PRBucket | FileItem | WelcomeItem)[]> {
        if (!element) {
            // Root level - show buckets and git changes
            if (!this.workspaceRoot) {
                return Promise.resolve([
                    {
                        isWelcome: true,
                        label: 'No Workspace',
                        description: 'Open a folder to get started',
                        tooltip: 'Open a folder containing a Git repository',
                        icon: 'folder-opened',
                        command: {
                            command: 'vscode.openFolder',
                            title: 'Open Folder'
                        }
                    } as WelcomeItem
                ]);
            }

            if (!this.isGitRepo) {
                return Promise.resolve([
                    {
                        isWelcome: true,
                        label: 'Not a Git Repository',
                        description: 'Initialize Git or open a Git repository',
                        tooltip: 'This folder is not a Git repository',
                        icon: 'source-control'
                    } as WelcomeItem
                ]);
            }

            const items: (PRBucket | FileItem | WelcomeItem)[] = [];

            // Add buckets
            items.push(...this.buckets);

            // Add separator if we have both buckets and files
            if (this.buckets.length > 0 && this.gitChanges.length > 0) {
                items.push({
                    isWelcome: true,
                    label: '── Available Files ──',
                    description: 'Drag files into buckets above',
                    tooltip: 'Files changed in your working directory',
                    icon: 'files'
                } as WelcomeItem);
            }

            // Show all changed files as a flat list with full relative paths
            items.push(...this.gitChanges);

            // Add welcome message if no changes
            if (this.buckets.length === 0 && this.gitChanges.length === 0) {
                items.push({
                    isWelcome: true,
                    label: 'No Changes Found',
                    description: 'Make some changes and click refresh',
                    tooltip: 'No modified files detected in the working directory',
                    icon: 'check',
                    command: {
                        command: 'multiPR.refresh',
                        title: 'Refresh'
                    }
                } as WelcomeItem);
            }

            return Promise.resolve(items);
        } else if ('files' in element) {
            // Bucket - show files in a structured way
            const items: (FileItem | WelcomeItem)[] = [];
            
            if (element.files.length === 0) {
                items.push({
                    isWelcome: true,
                    label: 'Empty bucket',
                    description: 'Drag files here',
                    tooltip: 'This bucket has no files. Drag files from the git changes below.',
                    icon: 'arrow-down'
                } as WelcomeItem);
            } else {
                // Show files in the bucket
                items.push(...element.files);
            }

            return Promise.resolve(items);
        } else if ((element as FileItem).isDirectory !== undefined && (element as FileItem).isDirectory) {
            // Directory - show contents from git changes that are in this directory
            const folderElement = element as FileItem;
            const folderItems = this.getFilesAndFoldersAtLevel(this.gitChanges, folderElement.path);
            return Promise.resolve(folderItems);
        } else {
            // File or welcome item - no children
            return Promise.resolve([]);
        }
    }


    // Drag and Drop Implementation
    async handleDrag(source: (PRBucket | FileItem)[], treeDataTransfer: vscode.DataTransfer): Promise<void> {
        // Only allow actual files (not buckets, not folders) to be dragged
        const fileItems = source
            .filter(item => !('files' in item))
            .filter(item => !(item as FileItem).isDirectory) as FileItem[];
        if (fileItems.length > 0) {
            treeDataTransfer.set('application/vnd.code.tree.multiprview', new vscode.DataTransferItem(fileItems));
        }
    }

    async handleDrop(target: PRBucket | FileItem | WelcomeItem | undefined, sources: vscode.DataTransfer): Promise<void> {
        const transferItem = sources.get('application/vnd.code.tree.multiprview');
        if (!transferItem) {
            return;
        }

        const fileItems = transferItem.value as FileItem[];

        if (target && 'files' in target) {
            // Dropping onto a bucket
            let moved = 0;
            fileItems.forEach(file => {
                if (this.moveFileToBucket(file, target)) {
                    moved++;
                }
            });

            if (moved > 0) {
                vscode.window.showInformationMessage(`✅ Moved ${moved} file(s) to ${target.name}`);
            }
        } else {
            // Dropping onto root or other item - move back to git changes
            let moved = 0;
            fileItems.forEach(file => {
                if (this.moveFileToGitChanges(file)) {
                    moved++;
                }
            });

            if (moved > 0) {
                vscode.window.showInformationMessage(`↩️ Moved ${moved} file(s) back to available files`);
            }
        }

        this.refresh();
    }

    private moveFileToBucket(file: FileItem, bucket: PRBucket): boolean {
        // Check if file is already in this bucket
        if (bucket.files.find(f => f.path === file.path)) {
            return false;
        }

        // Remove from git changes
        const gitIndex = this.gitChanges.findIndex(f => f.path === file.path);
        if (gitIndex > -1) {
            this.gitChanges.splice(gitIndex, 1);
        }

        // Remove from other buckets
        this.buckets.forEach(b => {
            const bucketIndex = b.files.findIndex(f => f.path === file.path);
            if (bucketIndex > -1) {
                b.files.splice(bucketIndex, 1);
            }
        });

        // Add to target bucket
        bucket.files.push(file);
        return true;
    }

    private moveFileToGitChanges(file: FileItem): boolean {
        // Check if file is already in git changes
        if (this.gitChanges.find(f => f.path === file.path)) {
            return false;
        }

        // Remove from all buckets
        let removed = false;
        this.buckets.forEach(bucket => {
            const index = bucket.files.findIndex(f => f.path === file.path);
            if (index > -1) {
                bucket.files.splice(index, 1);
                removed = true;
            }
        });

        // Add back to git changes
        if (removed) {
            this.gitChanges.push(file);
        }

        return removed;
    }
}

interface WelcomeItem {
    isWelcome: true;
    label: string;
    description: string;
    tooltip: string;
    icon: string;
    command?: vscode.Command;
}