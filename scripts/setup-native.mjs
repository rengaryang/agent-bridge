import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=process.argv[2]??'all';
if(!['pi','omp','all'].includes(target))throw new Error('Target must be pi, omp or all');
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Pinned native stage currently supports macOS arm64 only');
for(const name of (target==='all'?['pi','omp']:[target]))execFileSync('npm',['--prefix',path.join(root,'runtimes',name),'ci','--ignore-scripts','--omit=optional','--no-audit'],{stdio:'inherit'});
