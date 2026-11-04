// sync_push.js — 内容寻址的 Git 同步推送(经 GitHub API,绕开被墙的 git 443)
// 原理:对比本地 HEAD 树与远程 HEAD 树,只上传差异 blob,远程生成等价提交,保证两边树 SHA 一致。
// 本地与远程提交 SHA 可能不同(时间戳/签名差异),以树 SHA 一致为同步标准。
// 用法: node sync_push.js <repo> <branch> [commit消息(可多行)]
const { execSync } = require('child_process');

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = process.argv[2] || 'QIANwinner/Tank-battle';
const BRANCH = process.argv[3] || 'main';
const CUSTOM_MSG = process.argv[4];
const REPO_DIR = 'C:/Users/21889/Desktop/开源项目/Tank-battle';
const STATE_FILE = path.join(REPO_DIR, '.workbuddy', 'remote_sync.json');

// gh.exe 常不在 PATH(本机安装于 Program Files/GitHub CLI);且代理 3428 常返 502,
// 直连 api.github.com 反而可用 —— 显式解析 gh 路径并剥离代理变量,保证循环发布稳定。
const GH_BIN = (() => {
  if (process.env.GH_BIN && fs.existsSync(process.env.GH_BIN)) return process.env.GH_BIN;
  const abs = 'C:/Program Files/GitHub CLI/gh.exe';
  return fs.existsSync(abs) ? abs : 'gh';
})();
function ghEnv() {
  const env = { ...process.env };
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy']) delete env[k];
  return env;
}
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// GitHub API 偶发 502 / 200 但空响应体(2026-11-04 实测):传输层重试,
// blob/tree 内容寻址天然幂等,commit/ref 重复写入最多留下一个悬挂提交,树仍一致。
function gh(args, input) {
  if (input !== undefined) {
    const tmp = path.join(os.tmpdir(), 'gh_in_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.json');
    fs.writeFileSync(tmp, input);
    args += ' --input "' + tmp + '"';
  }
  let last = '';
  // 代理可用性会反转:先保留系统代理,再剥离代理;每通道各重试 3 次。
  // blob/tree 内容寻址天然幂等,commit/ref 重复写入最多留下一个悬挂提交,树仍一致。
  for (const strip of [false, true]) {
    const env = strip ? ghEnv() : { ...process.env };
    const opts = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env, timeout: 120000 };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const out = execSync('"' + GH_BIN + '" api ' + args, opts).trim();
        if (out) return out;
        last = 'empty response body';
      } catch (e) {
        last = (e.stderr || e.message || '').toString().slice(0, 200);
        if (/404|Not Found|Validation Failed/i.test(last)) break;   // 确定性错误不重试
      }
      if (attempt < 3) pause(600 * attempt);
    }
  }
  throw new Error('gh api ' + args.split(' ')[0] + ' failed after retries: ' + last);
}
function git(args) {
  return execSync('git -C "' + REPO_DIR + '" ' + args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

(async () => {
  const localHead = git('rev-parse HEAD');
  const localTree = git('rev-parse "HEAD^{tree}"');
  // 本地工作树若有未提交改动则拒绝同步(必须先 commit)
  const dirty = git('status --porcelain');
  if (dirty) { console.error('FATAL: 本地工作树不干净,先 commit:\n' + dirty); process.exit(3); }

  const remoteRef = JSON.parse(gh(`repos/${REPO}/git/ref/heads/${BRANCH}`));
  const remoteHead = remoteRef.object.sha;
  const remoteTree = JSON.parse(gh(`repos/${REPO}/git/commits/${remoteHead}`)).tree.sha;
  console.log('local :', localHead.slice(0, 10), 'tree', localTree.slice(0, 10));
  console.log('remote:', remoteHead.slice(0, 10), 'tree', remoteTree.slice(0, 10));

  if (remoteTree === localTree) {
    console.log('ALREADY SYNCED(树一致)');
    fs.writeFileSync(STATE_FILE, JSON.stringify({ remoteSha: remoteHead, tree: remoteTree, localHead, at: new Date().toISOString() }, null, 2));
    process.exit(0);
  }

  // 差异 = 递归树逐路径对比(远程独有 → 删除;本地独有/不同 → 上传本地对象)
  const rt = JSON.parse(gh(`repos/${REPO}/git/trees/${remoteTree}?recursive=1`))
    .tree.filter(x => x.type === 'blob');
  const remoteMap = new Map(rt.map(x => [x.path, x.sha]));
  const localMap = new Map(git('ls-tree -r HEAD').split('\n').filter(Boolean).map(l => {
    const [meta, p] = l.split('\t'); const sha = meta.split(' ')[2];
    return [p, sha];
  }));

  const entries = [];
  for (const [p, lsha] of localMap) {
    if (remoteMap.get(p) !== lsha) {
      // 原始字节直取 buffer 转 base64,避免任何文本解码破坏多字节内容
      const b64 = execSync(`git -C "${REPO_DIR}" cat-file blob ${lsha}`, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).toString('base64');
      const blob = JSON.parse(gh(`-X POST repos/${REPO}/git/blobs`, JSON.stringify({ content: b64, encoding: 'base64' })));
      if (blob.sha !== lsha) throw new Error(`blob SHA 不一致 ${p}: 远端 ${blob.sha} vs 本地 ${lsha}`);
      entries.push({ path: p, mode: '100644', type: 'blob', sha: lsha });
      console.log('  upload:', p, lsha.slice(0, 8));
    }
  }
  for (const [p, rsha] of remoteMap) {
    if (!localMap.has(p)) { entries.push({ path: p, mode: '100644', type: 'blob', sha: null }); console.log('  delete:', p, rsha.slice(0, 8)); }
  }
  if (!entries.length) throw new Error('树 SHA 不同但无路径差异?中止');

  const tree = JSON.parse(gh(`-X POST repos/${REPO}/git/trees`, JSON.stringify({ base_tree: remoteTree, tree: entries })));
  if (tree.sha !== localTree) throw new Error(`合成树 ${tree.sha} != 本地树 ${localTree},中止(内容可能被过滤规则改写)`);
  console.log('tree ok:', tree.sha.slice(0, 10), '(与本地一致)');

  const msg = CUSTOM_MSG || git('log -1 --format=%B');
  const commit = JSON.parse(gh(`-X POST repos/${REPO}/git/commits`, JSON.stringify({ message: msg, tree: tree.sha, parents: [remoteHead] })));
  gh(`-X PATCH repos/${REPO}/git/refs/heads/${BRANCH}`, JSON.stringify({ sha: commit.sha, force: false }));
  console.log('remote commit:', commit.sha, '(parent ' + remoteHead.slice(0, 10) + ')');

  git('update-ref refs/remotes/origin/' + BRANCH + ' ' + localHead);   // 追踪引用对齐本地(状态显示用)
  fs.writeFileSync(STATE_FILE, JSON.stringify({ remoteSha: commit.sha, tree: tree.sha, localHead, at: new Date().toISOString() }, null, 2));
  console.log('SYNC OK: 远程树 == 本地树', tree.sha.slice(0, 10));
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
