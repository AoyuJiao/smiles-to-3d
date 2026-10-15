/* =========================================================================
 * SMILES → 3D SDF Converter  (browser, RDKit WASM)
 * Engine: official RDKit (MinimalLib) custom build adding set_3d_coords
 *         = ETKDGv3 embedding + MMFF94/UFF refinement
 * ======================================================================= */
'use strict';

const $ = id => document.getElementById(id);

/* ---------- RDKit init ---------- */
let RDKit = null;
let rdkitReady = false;

function setRdkitStatus(cls, text){
  const el = $('rdkitStatus');
  el.className = 'badge ' + cls;
  el.textContent = text;
}

function initRDKit(){
  return new Promise((resolve, reject) => {
    if (typeof initRDKitModule !== 'function'){ reject(new Error('RDKit_minimal.js not loaded')); return; }
    initRDKitModule().then(mod => { RDKit = mod; resolve(RDKit); }).catch(reject);
  });
}

initRDKit().then(mod => {
  rdkitReady = true;
  setRdkitStatus('ready', 'RDKit ' + mod.version() + ' ready');
  $('btnConvert').disabled = !$('input').value.trim();
}).catch(err => {
  setRdkitStatus('err', 'RDKit load failed');
  $('statusOut').className = 'status err';
  $('statusOut').textContent = 'RDKit WASM failed to load: ' + err.message +
    '\nVerify /rdkit/RDKit_minimal.wasm is available (~6.6 MB, first load).';
});

/* =========================================================================
 * Input parsing: one SMILES per line, optional trailing title
 * ======================================================================= */
function parseSmilesInput(text){
  const out = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let raw of lines){
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Support "SMILES<sep>title" where sep is whitespace or tab.
    // SMILES itself never contains whitespace, so split on first whitespace run.
    let smi = line, title = '';
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (m){ smi = m[1]; title = m[2].trim(); }
    // Also tolerate "title,SMILES" or "SMILES,title" comma forms only if the
    // SMILES part still parses — keep it simple: if the token has a comma and
    // the first token is not a valid-looking SMILES, try the second token.
    out.push({ smiles: smi, title });
  }
  return out;
}

/* =========================================================================
 * Conversion
 * ======================================================================= */
async function convertAll(){
  if (!rdkitReady) return;
  const text = $('input').value;
  const stIn = $('statusIn'), stOut = $('statusOut');
  if (!text.trim()){ stIn.className = 'status err'; stIn.textContent = 'Input is empty.'; return; }

  const items = parseSmilesInput(text);
  if (!items.length){ stIn.className = 'status err'; stIn.textContent = 'No SMILES found.'; return; }

  const ff = $('optFF').value;
  const seed = parseInt($('optSeed').value, 10);
  const params = { forceField: ff };
  if (isFinite(seed)) params.randomSeed = seed;
  const paramsJson = JSON.stringify(params);

  const outputs = [];
  const summary = [];
  let firstMol = null;

  $('btnConvert').disabled = true;
  $('btnConvert').textContent = 'Converting…';

  for (let i = 0; i < items.length; i++){
    const { smiles, title } = items[i];
    let mol = null;
    try {
      mol = RDKit.get_mol(smiles);
      if (!mol || !mol.is_valid()){
        summary.push(`#${i+1} ${smiles}: ✗ invalid SMILES`);
        continue;
      }
      const rc = mol.set_3d_coords(paramsJson);
      if (rc === 0){
        summary.push(`#${i+1} ${smiles}: ✗ 3D embedding failed`);
        mol.delete(); mol = null;
        continue;
      }
      const name = title || (mol.get_prop ? (mol.has_prop('_Name') ? mol.get_prop('_Name') : '') : '') || `mol_${i+1}`;
      let mb = normalizeMolblock(mol.get_molblock(), name);
      outputs.push(mb);
      const nA = mol.get_num_atoms(), nB = mol.get_num_bonds();
      summary.push(`#${i+1} ${name}: ✓ ${nA} atoms / ${nB} bonds · FF ${ff === 'none' ? 'none' : ff}`);
      if (!firstMol) firstMol = { molblock: mb, name };
    } catch(e){
      summary.push(`#${i+1} ${smiles}: ✗ ${e.message}`);
    } finally {
      if (mol) mol.delete();
    }
    await new Promise(r => setTimeout(r, 0));
  }

  window.__lastSDF = outputs.join('');
  stIn.className = 'status ok';
  stIn.textContent = `Parsed ${items.length} SMILES.`;

  if (!outputs.length){
    stOut.className = 'status err';
    stOut.textContent = 'Conversion failed:\n' + summary.join('\n');
  } else {
    stOut.className = 'status ok';
    stOut.textContent = `Done: ${outputs.length}/${items.length} → 3D.\n` + summary.join('\n');
  }

  $('btnCopy').disabled = !outputs.length;
  $('btnDownload').disabled = !outputs.length;
  $('btnConvert').disabled = false;
  $('btnConvert').textContent = 'Convert to 3D';

  if (firstMol){
    renderMolblock(firstMol.molblock);
    $('molInfo').textContent = `${firstMol.name} · ${countAtoms(firstMol.molblock)} atoms`;
  }
}

/* Ensure the molblock carries a title and is flagged 3D, terminated with $$$$ */
function normalizeMolblock(mb, title){
  const lines = mb.replace(/\r\n?/g, '\n').split('\n');
  lines[0] = title || lines[0] || 'converted';
  if (lines[1] && !/3D/.test(lines[1])){
    lines[1] = (lines[1] || '').slice(0, 20).padEnd(20, ' ') + '3D';
  }
  let body = lines.join('\n').replace(/\n+$/, '');
  if (!/M\s+END/.test(body)) body += '\nM  END';
  return body + '\n$$$$\n';
}

function countAtoms(mb){
  const lines = mb.split('\n');
  for (let i = 3; i < Math.min(6, lines.length); i++){
    if (/V2000|V3000/.test(lines[i])) return parseInt(lines[i].slice(0,3),10) || 0;
  }
  return 0;
}

/* =========================================================================
 * 3D renderer (Canvas, no external deps; ball-and-stick, depth sorted)
 * ======================================================================= */
const CPK = {H:'#ffffff',C:'#3f4650',N:'#3050f8',O:'#ff2d2d',F:'#8fe04f',Cl:'#28e028',
  Br:'#a62929',I:'#9b009b',S:'#ffd92d',P:'#ff8c1a',B:'#ff9bb0',Si:'#c8a0f0',Se:'#ffa100',
  As:'#bd80e3',Na:'#ab5cf2',K:'#8f40d4',Ca:'#3dff00',Fe:'#e06633',Zn:'#7d80b0',Mg:'#8aff00',
  Li:'#cc80ff',Al:'#bfa6a6',Cu:'#c88033',Mn:'#9c7ac7',Ni:'#50d050',Co:'#f090a0'};
const RAD = {H:0.28,C:0.42,N:0.40,O:0.38,F:0.34,Cl:0.50,Br:0.54,I:0.60,S:0.50,P:0.50,B:0.44,Si:0.50};
const colorOf = e => CPK[e] || '#b8c0cc';
const radiusOf = e => RAD[e] || 0.44;

let scene = null;
let rotX = -0.45, rotY = 0.6, zoom = 1, spin = false;

function parseMolblockForRender(mb){
  const lines = mb.split('\n');
  let ci = -1;
  for (let i = 3; i < Math.min(6, lines.length); i++) if (/V2000|V3000/.test(lines[i])) { ci = i; break; }
  if (ci < 0) return null;
  const na = parseInt(lines[ci].slice(0,3),10)||0;
  const nb = parseInt(lines[ci].slice(3,6),10)||0;
  const atoms = [], bonds = [];
  let p = ci+1;
  for (let k=0;k<na;k++,p++){
    const L = lines[p]||'';
    const x=parseFloat(L.slice(0,10)), y=parseFloat(L.slice(10,20)), z=parseFloat(L.slice(20,30));
    let sym=(L.slice(31,34)||'').trim(); sym=sym.replace(/[^A-Za-z]/g,'');
    sym = sym ? sym[0].toUpperCase()+sym.slice(1).toLowerCase() : 'C';
    atoms.push({el:sym, x:isFinite(x)?x:0, y:isFinite(y)?y:0, z:isFinite(z)?z:0});
  }
  for (let k=0;k<nb;k++,p++){
    const L=lines[p]||'';
    const a1=parseInt(L.slice(0,3),10), a2=parseInt(L.slice(3,6),10), t=parseInt(L.slice(6,9),10)||1;
    if (a1&&a2) bonds.push({a1:a1-1,a2:a2-1,type:t});
  }
  return {atoms, bonds};
}

function renderMolblock(mb){
  const m = parseMolblockForRender(mb);
  if (!m) return;
  let c=[0,0,0]; for (const a of m.atoms){c[0]+=a.x;c[1]+=a.y;c[2]+=a.z;}
  const n = m.atoms.length || 1; c=c.map(v=>v/n);
  for (const a of m.atoms){ a.x-=c[0]; a.y-=c[1]; a.z-=c[2]; }
  scene = m;
  spin = $('optSpin').checked;
  draw();
}

function rotPoint(p){
  let [x,y,z]=p;
  const cy=Math.cos(rotY), sy=Math.sin(rotY);
  let x1=x*cy+z*sy, z1=-x*sy+z*cy;
  const cx=Math.cos(rotX), sx=Math.sin(rotX);
  let y1=y*cx-z1*sx, z2=y*sx+z1*cx;
  return [x1,y1,z2];
}
function shade(hex, amt){
  const c=hex.replace('#',''); const num=parseInt(c.length===3?c.replace(/(.)/g,'$1$1'):c,16);
  let r=(num>>16)&255,g=(num>>8)&255,b=num&255;
  r=Math.max(0,Math.min(255,r+255*amt)); g=Math.max(0,Math.min(255,g+255*amt)); b=Math.max(0,Math.min(255,b+255*amt));
  return `rgb(${r|0},${g|0},${b|0})`;
}
function draw(){
  const cv = $('view');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W*dpr || cv.height !== H*dpr){ cv.width=W*dpr; cv.height=H*dpr; }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  if (!scene){
    ctx.fillStyle='#5b6472'; ctx.font='13px system-ui'; ctx.textAlign='center';
    ctx.fillText('The 3D structure will appear here', W/2, H/2); return;
  }
  const stick = $('optStick').checked;
  let maxR=0.5; for (const a of scene.atoms) maxR=Math.max(maxR, Math.hypot(a.x,a.y,a.z));
  const scale = Math.min(W,H)/2/(maxR*1.5)*zoom;
  const cx=W/2, cy=H/2;
  const rp = scene.atoms.map(a=>{ const p=rotPoint([a.x,a.y,a.z]); return [cx+p[0]*scale, cy+p[1]*scale, p[2]]; });
  const rad = scene.atoms.map(a=>radiusOf(a.el)*scale*(stick?0.55:0.95));

  for (const b of scene.bonds){
    const a=rp[b.a1], c=rp[b.a2];
    ctx.lineCap='round'; ctx.strokeStyle='#9aa6b8';
    const w = Math.max(2.5, 0.085*scale);
    if (b.type===2){
      const dx=c[0]-a[0], dy=c[1]-a[1], L=Math.hypot(dx,dy)||1, ox=-dy/L*w*0.45, oy=dx/L*w*0.45;
      ctx.lineWidth=w*0.72;
      ctx.beginPath(); ctx.moveTo(a[0]+ox,a[1]+oy); ctx.lineTo(c[0]+ox,c[1]+oy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(a[0]-ox,a[1]-oy); ctx.lineTo(c[0]-ox,c[1]-oy); ctx.stroke();
    } else if (b.type===3){
      const dx=c[0]-a[0], dy=c[1]-a[1], L=Math.hypot(dx,dy)||1, ox=-dy/L*w*0.5, oy=dx/L*w*0.5;
      ctx.lineWidth=w*0.6;
      for (const k of [1,-1,0]){ ctx.beginPath(); ctx.moveTo(a[0]+ox*k,a[1]+oy*k); ctx.lineTo(c[0]+ox*k,c[1]+oy*k); ctx.stroke(); }
    } else if (b.type===4){
      ctx.lineWidth=w;
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(c[0],c[1]); ctx.stroke();
      ctx.strokeStyle='#c3ccda'; ctx.lineWidth=Math.max(1, w*0.22); ctx.setLineDash([5,5]);
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(c[0],c[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle='#9aa6b8';
    } else {
      ctx.lineWidth=w;
      ctx.beginPath(); ctx.moveTo(a[0],a[1]); ctx.lineTo(c[0],c[1]); ctx.stroke();
    }
  }
  const order = scene.atoms.map((_,i)=>i).sort((i,j)=>rp[i][2]-rp[j][2]);
  for (const i of order){
    const p=rp[i], r=Math.max(2.2, rad[i]), el=scene.atoms[i].el;
    const g=ctx.createRadialGradient(p[0]-r*0.35,p[1]-r*0.38,r*0.08, p[0],p[1],r*1.05);
    const col=colorOf(el);
    g.addColorStop(0,'#ffffff'); g.addColorStop(0.30,col); g.addColorStop(1, shade(col,-0.42));
    ctx.fillStyle=g;
    ctx.beginPath(); ctx.arc(p[0],p[1],r,0,Math.PI*2); ctx.fill();
    if (!stick && r>10){
      ctx.fillStyle = (el==='H'||el==='C') ? '#d5dbe4' : '#0b0d10';
      ctx.font=`${Math.max(8, r*0.85)}px system-ui`; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(el[0], p[0], p[1]);
    }
  }
}

/* interaction */
(function(){
  const cv = $('view');
  let drag=false, lx=0, ly=0;
  const start=e=>{ drag=true; const t=e.touches?e.touches[0]:e; lx=t.clientX; ly=t.clientY; };
  const move=e=>{ if(!drag) return; const t=e.touches?e.touches[0]:e;
    rotY += (t.clientX-lx)*0.011; rotX -= (t.clientY-ly)*0.011;
    lx=t.clientX; ly=t.clientY; draw(); if(e.touches) e.preventDefault(); };
  const end=()=>{ drag=false; };
  cv.addEventListener('mousedown',start); window.addEventListener('mousemove',move); window.addEventListener('mouseup',end);
  cv.addEventListener('touchstart',start,{passive:true}); cv.addEventListener('touchmove',move,{passive:false}); cv.addEventListener('touchend',end);
  cv.addEventListener('wheel',e=>{ e.preventDefault(); zoom *= (e.deltaY<0?1.1:0.9); zoom=Math.max(0.2,Math.min(8,zoom)); draw(); },{passive:false});
  cv.addEventListener('dblclick',()=>{ rotX=-0.45; rotY=0.6; zoom=1; draw(); });
})();
setInterval(()=>{ if(spin && scene){ rotY += 0.012; draw(); } }, 40);
window.addEventListener('resize', ()=>{ if(scene) draw(); });

/* =========================================================================
 * UI bindings
 * ======================================================================= */
const EXAMPLE =
`# SMILES examples — one per line, optional trailing title
CCO
Oc1ccccc1 phenol
CN1C=NC2=C1C(=O)N(C(=O)N2C)C caffeine
CC(=O)Oc1ccccc1C(=O)O aspirin
C[C@H](N)C(=O)O L-alanine
CC(C)Cc1ccc(cc1)C(C)C(=O)O ibuprofen
N[C@@H](Cc1ccc(O)cc1)C(=O)O L-tyrosine`;

$('btnLoadEx').addEventListener('click', ()=>{ $('input').value = EXAMPLE; $('btnConvert').disabled = !rdkitReady; });
$('btnClear').addEventListener('click', ()=>{
  $('input').value=''; window.__lastSDF=''; scene=null; draw();
  $('statusIn').className='status'; $('statusIn').textContent='Waiting for input.';
  $('statusOut').className='status'; $('statusOut').textContent='Waiting for conversion.';
  $('btnCopy').disabled=true; $('btnDownload').disabled=true; $('molInfo').textContent='—';
});
$('input').addEventListener('input', ()=>{ $('btnConvert').disabled = !rdkitReady || !$('input').value.trim(); });
$('btnConvert').addEventListener('click', convertAll);

$('btnFile').addEventListener('click', ()=> $('fileInput').click());
$('fileInput').addEventListener('change', e=>{
  const f=e.target.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=()=>{ $('input').value = r.result; $('btnConvert').disabled=!rdkitReady; };
  r.readAsText(f);
});

const drop = $('drop');
['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.add('hot'); }));
['dragleave','drop'].forEach(ev=>drop.addEventListener(ev, e=>{ e.preventDefault(); drop.classList.remove('hot'); }));
drop.addEventListener('drop', e=>{
  const f=e.dataTransfer.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=()=>{ $('input').value=r.result; $('btnConvert').disabled=!rdkitReady; }; r.readAsText(f);
});
drop.addEventListener('click', ()=> $('fileInput').click());
document.addEventListener('dragover', e=>e.preventDefault());
document.addEventListener('drop', e=>{
  const f=e.dataTransfer && e.dataTransfer.files[0]; if(!f) return;
  e.preventDefault();
  const r=new FileReader(); r.onload=()=>{ $('input').value=r.result; $('btnConvert').disabled=!rdkitReady; }; r.readAsText(f);
});

$('btnCopy').addEventListener('click', async ()=>{
  const t=window.__lastSDF||''; if(!t) return;
  try{ await navigator.clipboard.writeText(t); $('statusOut').textContent += '\nCopied to clipboard.'; }
  catch(e){ $('statusOut').textContent += '\nCopy failed (browser restriction).'; }
});
$('btnDownload').addEventListener('click', ()=>{
  const t=window.__lastSDF||''; if(!t) return;
  const blob=new Blob([t],{type:'chemical/x-mdl-sdfile'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='converted_3d.sdf'; a.click();
  URL.revokeObjectURL(a.href);
});
$('optStick').addEventListener('change', draw);
$('optSpin').addEventListener('change', ()=>{ spin = $('optSpin').checked; });

draw();
