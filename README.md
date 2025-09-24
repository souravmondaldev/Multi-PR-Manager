# Multi-PR Manager 🚀

**A VSCode extension that allows you to create multiple Pull Requests from the same branch using an intuitive drag-and-drop interface.**

## ✨ Features

- 🎯 **Drag & Drop Interface**: Easily organize changed files into different PR buckets
- 🌿 **Multiple PRs**: Create separate PRs from the same working branch  
- 🔄 **No Token Required**: Uses GitHub CLI or manual workflow (no personal access tokens!)
- ⚡ **Automated Workflow**: Automatically creates branches, commits, and PRs
- 📝 **Custom PR Details**: Set title and description for each PR
- 🎨 **Visual Interface**: Clean, modern UI integrated with VSCode's Source Control

## 🚀 Quick Start

1. **Install the extension** from the marketplace
2. **Open a Git repository** in VSCode
3. **Make changes** to multiple files
4. **Open Source Control panel** and find "Multi-PR Manager"
5. **Create buckets** using the "+" button
6. **Drag files** into appropriate buckets
7. **Create PRs** with one click!

## 📋 Requirements

- **Git repository** (local)
- **GitHub repository** (with remote origin)
- **GitHub CLI** (recommended) - Install from [cli.github.com](https://cli.github.com/)
  - OR manual PR creation (no additional tools needed)

## 🛠️ Setup Options

### Option 1: GitHub CLI (Recommended - No Token Required!)
1. Install GitHub CLI: `brew install gh` or visit [cli.github.com](https://cli.github.com/)
2. Authenticate: `gh auth login`
3. That's it! The extension will create PRs automatically.

### Option 2: Manual (No Setup Required)
- Extension creates branches and opens GitHub for manual PR creation
- No authentication setup needed

## 📱 How to Use

### Step 1: Make Changes
Make changes to multiple files in your repository.

### Step 2: Open Multi-PR Manager  
1. Open the **Source Control panel** (Ctrl+Shift+G)
2. Find **"Multi-PR Manager"** section
3. You'll see all your changed files listed

### Step 3: Create Buckets
1. Click the **"+" button** to create a new PR bucket
2. Give it a name like "Database Changes" or "UI Updates"  
3. Set a PR title and description

### Step 4: Organize Files
**Drag and drop** files from the "Available Files" section into your buckets.

### Step 5: Create PRs
Click **"Create All PRs"** and the extension will:
- ✅ Create feature branches for each bucket
- ✅ Stage and commit files to respective branches  
- ✅ Push branches to GitHub
- ✅ Create Pull Requests (with GitHub CLI) or open browser for manual creation

## ⚙️ Configuration

Open VSCode Settings and search for "Multi-PR Manager":

- `multiPR.defaultBaseBranch`: Base branch for PRs (default: "main")
- `multiPR.useGitHubCLI`: Use GitHub CLI for automatic PR creation (default: true)

## 🔧 How It Works

Since GitHub doesn't support multiple PRs from the same branch, this extension:

1. **Creates temporary feature branches** for each PR bucket
2. **Cherry-picks relevant files** to each branch using selective staging
3. **Creates separate PRs** from each feature branch
4. **Maintains clean history** and proper PR organization

## 🆚 Why This Extension?

**Before**: Manual, tedious process
- Create branches manually
- Remember which files go where  
- Copy-paste file changes
- Create PRs individually

**After**: Drag, drop, done!
- Visual organization of changes
- One-click PR creation
- Clean, separate commit history
- No token management hassles

## 🐛 Troubleshooting

### Extension not visible?
- Make sure you're in a Git repository
- Check that Source Control panel is open (Ctrl+Shift+G)
- Look for "Multi-PR Manager" section

### No files showing?
- Make some changes to files first
- Click the refresh button in Multi-PR Manager
- Check if files are already staged with `git status`

### GitHub CLI not working?
- Install: `brew install gh` or visit [cli.github.com](https://cli.github.com/)
- Login: `gh auth login`  
- Test: `gh auth status`

### PRs not creating automatically?
- Extension will still create branches and open GitHub
- You can create PRs manually - branches are already pushed!

## 🤝 Contributing

Found a bug or want to contribute? 
- Report issues on GitHub
- Submit pull requests
- Share feedback and suggestions

## 📄 License

MIT License - feel free to use and modify!

---

**🎉 Happy coding! Create better PRs, faster than ever.**