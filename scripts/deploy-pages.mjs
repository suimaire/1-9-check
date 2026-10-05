// dist/ 를 GitHub Pages(gh-pages 브랜치)로 올린다. 먼저 `npm run build`.
// 빌드에는 공개 값(VITE_SUPABASE_URL, publishable key)만 들어간다. secret key가 보이면 중단한다.
// (GitHub Actions 배포는 gh 토큰에 workflow 권한이 있어야 해서 브랜치 배포를 쓴다.)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(ROOT, 'dist');
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html이 없습니다. 먼저 npm run build를 실행하세요.');
  process.exit(1);
}
const js = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(DIST, 'assets', f), 'utf8')).join('\n');
if (/sb_secret_[A-Za-z0-9_-]{16,}/.test(js) || /service_role/.test(js)) {
  console.error('빌드에 secret key로 보이는 값이 있습니다. 배포를 중단합니다.');
  process.exit(1);
}

const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const remote = git(['remote', 'get-url', 'origin']);
const source = git(['rev-parse', '--short', 'HEAD']);

const tmp = mkdtempSync(join(tmpdir(), '1-9-check-pages-'));
try {
  cpSync(DIST, tmp, { recursive: true });
  writeFileSync(join(tmp, '.nojekyll'), '');
  git(['init', '-q', '-b', 'gh-pages'], tmp);
  git(['add', '-A'], tmp);
  git(['commit', '-q', '-m', `Deploy ${source}`], tmp);
  git(['push', '-q', '-f', remote, 'gh-pages'], tmp);
  console.log(`gh-pages 배포 완료 (소스 ${source})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
