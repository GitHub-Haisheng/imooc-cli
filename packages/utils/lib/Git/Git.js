const fs = require('fs');
const path = require('path');
const fse = require('fs-extra');
const SimpleGit = require('simple-git');
const userHome = require('user-home');
const semver = require('semver');
const log = require('../log');
const inquirer = require('../inquirer');
const terminalLink = require('../terminalLink');
const spinner = require('../spinner');
const Github = require('./Github');
const Gitee = require('./Gitee');
const CloudBuild = require('../Build/CloudBuild');
const { readFile, writeFile } = require('../file');

const DEFAULT_CLI_HOME = '.imooc-cli';
const GIT_ROOT_DIR = '.git';
const GIT_SERVER_FILE = '.git_server';
const GIT_TOKEN_FILE = '.git_token';
const GIT_LOGIN_FILE = '.git_login';
const GIT_OWN_FILE = '.git_own';
const GIT_PUBLISH_FILE = '.git_publish';
const GIT_IGNORE_FILE = '.gitignore';
const REPO_OWNER_USER = 'user'; // 用户仓库
const REPO_OWNER_ORG = 'org'; // 组织仓库

const GITHUB = 'github';
const GITEE = 'gitee';

const VERSION_RELEASE = 'release';
const VERSION_DEVELOP = 'dev';

const GIT_SERVER_TYPE = [ {
  name: 'Github',
  value: GITHUB,
}, {
  name: 'Gitee(码云)',
  value: GITEE,
} ];

const GIT_OWNER_TYPE = [ {
  name: '个人',
  value: REPO_OWNER_USER,
}, {
  name: '组织',
  value: REPO_OWNER_ORG,
} ];

const GIT_OWNER_TYPE_ONLY = [ {
  name: '个人',
  value: REPO_OWNER_USER,
} ];

const GIT_PUBLISH_TYPE = [ {
  name: 'OSS',
  value: 'oss',
} ];

function createGitServer(gitServer) {
  if (gitServer === GITHUB) {
    return new Github();
  } else if (gitServer === GITEE) {
    return new Gitee();
  }
  return null;
}

/**
 * Git 操作基类
 */
class Git {
  /**
   * 构造函数
   *
   * @param dir git 仓库本地目录
   * @param name git 仓库名称
   * @param version git 分支号
   * @param cliHome 缓存根目录
   * @param refreshToken 是否强制刷新token数据
   * @param refreshOwner 是否强制刷新own数据
   * @param refreshServer 是否强制刷新git远程仓库类型
   */
  constructor({ dir, name, version }, { cliHome, refreshToken, refreshOwner, refreshServer, prod }) {
    this.git = SimpleGit(dir);
    this.name = name;
    this.version = version;
    this.dir = dir; // 仓库本地路径
    this.owner = REPO_OWNER_USER; // owner 信息
    this.login = null; // 当前登录用户信息
    this.repo = null; // git 仓库
    this.homePath = cliHome; // 用户缓存主目录
    this.refreshToken = refreshToken; // 强制刷新 token
    this.refreshOwner = refreshOwner; // 强制刷新 owner
    this.refreshServer = refreshServer; // 强制刷新 git 远程仓库类型
    this.gitServer = null; // 默认远程 git 服务
    this.prod = prod; // 是否为正式发布
  }

  // 核心业务逻辑，提交代码前的准备工作
  prepare = async () => {
    this.checkHomePath();
    await this.checkGitServer();
    await this.checkGitToken();
    await this.checkUserAndOrgs();
    await this.checkGitOwner();
    await this.checkRepo();
    await this.checkGitIgnore();
    await this.init();
  };

  // 检查缓存主目录
  checkHomePath = () => {
    if (!this.homePath) {
      if (process.env.CLI_HOME) {
        this.homePath = path.resolve(userHome, process.env.CLI_HOME);
      } else {
        this.homePath = path.resolve(userHome, DEFAULT_CLI_HOME);
      }
    }
    log.verbose('home', this.homePath);
    fse.ensureDirSync(this.homePath);
    if (!fs.existsSync(this.homePath)) {
      throw new Error('用户主目录获取失败！');
    }
  };

  // 创建缓存目录
  createPath = (file) => {
    const rootDir = path.resolve(this.homePath, GIT_ROOT_DIR);
    const filePath = path.resolve(rootDir, file);
    fse.ensureDirSync(rootDir);
    return filePath;
  };

  // 选择远程 git 平台
  checkGitServer = async () => {
    const gitServerPath = this.createPath(GIT_SERVER_FILE);
    let gitServer = readFile(gitServerPath);
    if (!gitServer || this.refreshServer) {
      gitServer = await inquirer({
        type: 'list',
        choices: GIT_SERVER_TYPE,
        message: '请选择您想要托管的Git平台',
      });
      writeFile(gitServerPath, gitServer);
      log.success('git server写入成功', `${gitServer} -> ${gitServerPath}`);
    } else {
      log.success('git server获取成功', gitServer);
    }
    this.gitServer = createGitServer(gitServer);
  };

  // 检查 git API 必须的 token
  checkGitToken = async () => {
    const tokenPath = this.createPath(GIT_TOKEN_FILE);
    let token = readFile(tokenPath);
    if (!token || this.refreshToken) {
      log.notice(this.gitServer.type + ' token未生成', '请先生成 ' + this.gitServer.type + ' token，' + terminalLink('链接', this.gitServer.getTokenHelpUrl()));
      token = await inquirer({
        type: 'password',
        message: '请将token复制到这里',
        defaultValue: '',
      });
      writeFile(tokenPath, token);
      log.success('token 写入成功', `${token} -> ${tokenPath}`);
    } else {
      log.verbose('token', token);
      log.success('token 获取成功', tokenPath);
    }
    this.token = token;
    this.gitServer.setToken(token);
  };

  // 获取用户和组织信息
  checkUserAndOrgs = async () => {
    this.user = await this.gitServer.getUser();
    this.orgs = await this.gitServer.getOrgs();
    if (!this.user) {
      throw new Error('用户或组织信息获取失败');
    }
    log.success(this.gitServer.type + ' 用户和组织信息获取成功');
  };

  // 检查 git owner 是否选择
  checkGitOwner = async () => {
    const ownerPath = this.createPath(GIT_OWN_FILE);
    const loginPath = this.createPath(GIT_LOGIN_FILE);
    let owner = readFile(ownerPath);
    let login = readFile(loginPath);
    if (!owner || !login || this.refreshOwner) {
      log.notice(this.gitServer.type + ' owner 未生成，先选择 owner');
      owner = await inquirer({
        type: 'list',
        choices: this.orgs.length > 0 ? GIT_OWNER_TYPE : GIT_OWNER_TYPE_ONLY,
        message: '请选择远程仓库类型',
      });
      if (owner === REPO_OWNER_USER) {
        login = this.user.login;
      } else {
        login = await inquirer({
          type: 'list',
          choices: this.orgs.map(item => ({
            name: item.login,
            value: item.login,
          })),
          message: '请选择',
        });
      }
      writeFile(ownerPath, owner);
      writeFile(loginPath, login);
      log.success('git owner写入成功', `${owner} -> ${ownerPath}`);
      log.success('git login写入成功', `${login} -> ${loginPath}`);
    } else {
      log.success('git owner 获取成功', owner);
      log.success('git login 获取成功', login);
    }
    this.owner = owner;
    this.login = login;
  };

  // 检查远程仓库
  checkRepo = async () => {
    let repo = await this.gitServer.getRepo(this.login, this.name);
    if (!repo) {
      let spinnerStart = spinner('开始创建远程仓库...');
      try {
        if (this.owner === REPO_OWNER_USER) {
          repo = await this.gitServer.createRepo(this.name);
        } else {
          repo = await this.gitServer.createOrgRepo(this.name, this.login);
        }
      } finally {
        spinnerStart.stop(true);
      }
      if (repo) {
        log.success('远程仓库创建成功');
      } else {
        throw new Error('远程仓库创建失败');
      }
    }
    log.success('远程仓库信息获取成功');
    this.repo = repo;
  };

  // 检查 .gitignore
  checkGitIgnore = async () => {
    const gitIgnore = path.resolve(this.dir, GIT_IGNORE_FILE);
    if (!fs.existsSync(gitIgnore)) {
      writeFile(gitIgnore, `.DS_Store
node_modules
/dist


# local env files
.env.local
.env.*.local

# Log files
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Editor directories and files
.idea
.vscode
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?`);
      log.success('自动写入 .gitignore 文件');
    }
  };

  // 初始化
  init = async () => {
    const gitPath = path.resolve(this.dir, GIT_ROOT_DIR);
    this.remote = this.gitServer.getRemote(this.login, this.name);
    if (fs.existsSync(gitPath)) {
      log.success('git 已完成初始化');
      return;
    }
    log.notice('执行 git 初始化');
    await this.git.init(this.dir);
    log.notice('添加 git remote');
    const remotes = await this.git.getRemotes();
    log.verbose('git remotes', remotes);
    if (!remotes.find(item => item.name === 'origin')) {
      await this.git.addRemote('origin', this.remote);
    }
    await this.initCommit();
  };

  initCommit = async () => {
    await this.checkConflicted();
    await this.checkNotCommitted();
    if (await this.checkRemoteMaster()) {
      log.notice('远程存在 master 分支，强制合并');
      await this.pullRemoteRepo('master', { '--allow-unrelated-histories': null });
    } else {
      await this.pushRemoteRepo('master');
    }
  };

  checkRemoteMaster = async () => {
    return (await this.git.listRemote([ '--refs' ])).indexOf('refs/heads/master') >= 0;
  };

  checkConflicted = async () => {
    log.notice('代码冲突检查');
    const status = await this.git.status();
    if (status.conflicted.length > 0) {
      throw new Error('当前代码存在冲突，请手动处理合并后再试！');
    }
    log.success('代码检查通过');
  };

  checkNotCommitted = async () => {
    const status = await this.git.status();
    if (status.not_added.length > 0 ||
      status.created.length > 0 ||
      status.deleted.length > 0 ||
      status.modified.length > 0 ||
      status.renamed.length > 0) {
      log.verbose('status', status);
      await this.git.add(status.not_added);
      await this.git.add(status.created);
      await this.git.add(status.deleted);
      await this.git.add(status.modified);
      await this.git.add(status.renamed);
      let message;
      while (!message) {
        message = await inquirer({
          type: 'text',
          message: '请输入 commit 信息：',
          defaultValue: '',
        });
      }
      await this.git.commit(message);
      log.success('本地 commit 提交成功');
    }
  };

  pullRemoteRepo = async (branchName, options = {}) => {
    log.notice(`同步远程 ${branchName} 分支代码`);
    await this.git.pull('origin', branchName, options).catch(err => {
      if (err.message.indexOf('Permission denied (publickey)') >= 0) {
        throw new Error(`请获取本地 ssh publickey 并配置到：${this.gitServer.getSSHKeysUrl()}，配置方法：${this.gitServer.getSSHKeysHelpUrl()}`);
      } else if (err.message.indexOf('Couldn\'t find remote ref ' + branchName) >= 0) {
        log.notice('获取远程 [' + branchName + '] 分支失败');
      } else {
        log.error(err.message);
      }
      process.exit(0);
    });
  };

  pushRemoteRepo = async (branchName) => {
    log.notice(`推送代码至远程 ${branchName} 分支`);
    await this.git.push('origin', branchName);
    log.success('推送代码成功');
  };

  getCorrectVersion = async (type) => {
    log.notice('获取代码分支');
    const remoteBranchList = await this.getRemoteBranchList(type);
    if (remoteBranchList) {
      // 获取正确的版本号
    }
    this.branch = `${type || VERSION_DEVELOP}/${this.version}`;
    log.success(`代码分支获取成功 ${this.branch}`);
  };

  getRemoteBranchList = async (type) => {
    // git ls-remote --refs
    const remoteList = await this.git.listRemote([ '--refs' ]);
    console.log(remoteList);
    let reg;
    if (type === VERSION_RELEASE) {
      reg = /.+?refs\/tags\/release\/(\d+\.\d+\.\d+)/g;
    } else {
      reg = /.+?refs\/heads\/dev\/(\d+\.\d+\.\d+)/g;
    }
    const branchList = remoteList.split('\n').map(remote => {
      const match = reg.exec(remote);
      if (match && semver.valid(match[1])) {
        return match[1];
      }
    }).filter(_ => _);
    return branchList;
  };

  checkoutBranch = async () => {
    const localBranchList = await this.git.branchLocal();
    if (localBranchList.all.indexOf(this.branch) >= 0) {
      await this.git.checkout(this.branch);
    } else {
      await this.git.checkoutLocalBranch(this.branch);
    }
    log.success(`分支切换到${this.branch}`);
  };

  checkStash = async () => {
    log.notice('检查 stash 记录');
    const stashList = await this.git.stashList();
    if (stashList.all.length > 0) {
      await this.git.stash([ 'pop' ]);
      log.success('stash pop 成功');
    }
  };

  pullRemoteMasterAndBranch = async () => {
    log.notice(`合并 [master] -> [${this.branch}]`);
    await this.pullRemoteRepo('master');
    log.success('合并远程 [master] 分支内容成功');
    await this.checkConflicted();
    log.notice('检查远程分支');
    const remoteBranchList = await this.getRemoteBranchList();
    if (remoteBranchList.indexOf(this.version) >= 0) {
      log.notice(`合并 [${this.branch}] -> [${this.branch}]`);
      await this.pullRemoteRepo(this.branch);
      log.success(`合并远程 [${this.branch}] 分支内容成功`);
      await this.checkConflicted();
    } else {
      log.success(`不存在远程分支 [${this.branch}]`);
    }
  };

  // 提交代码
  commit = async () => {
    await this.getCorrectVersion();
    await this.checkStash();
    await this.checkConflicted();
    await this.checkNotCommitted();
    await this.checkoutBranch();
    await this.pullRemoteMasterAndBranch();
    await this.pushRemoteRepo(this.branch);
  };

  // 正式发布
  publish = async () => {
    log.notice('开始发布');
    const gitPublishTypePath = this.createPath(GIT_PUBLISH_FILE);
    let gitPublishType = readFile(gitPublishTypePath);
    if (!gitPublishType) {
      gitPublishType = await inquirer({
        type: 'list',
        choices: GIT_PUBLISH_TYPE,
        message: '请选择您想要上传代码的平台',
      });
      writeFile(gitPublishTypePath, gitPublishType);
      log.success('git publish类型写入成功', `${gitPublishType} -> ${gitPublishTypePath}`);
    } else {
      log.success('git publish类型获取成功', gitPublishType);
    }
    const cloudBuild = new CloudBuild(this, gitPublishType, { prod: this.prod });
    await cloudBuild.prepare();
    await cloudBuild.init();
    await cloudBuild.build();
  };
}

module.exports = Git;
