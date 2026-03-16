#!/usr/bin/env node
/**
 * Figma Sync Script
 * Figma APIからデザイントークン（色・フォント・スペーシング）を取得し、
 * CSS変数として figma-tokens.css に書き出します。
 *
 * 使い方:
 *   node figma-sync.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── 設定 ──────────────────────────────────────────────────────────────────
// FIGMA_TOKEN 環境変数またはローカル設定ファイル (.figma.json) から読み込みます
function loadConfig() {
  // 1. 環境変数を優先
  if (process.env.FIGMA_TOKEN) {
    return {
      token:  process.env.FIGMA_TOKEN,
      fileId: process.env.FIGMA_FILE_ID || 'zRNcYf0XoaaxhP3WqGvwQP',
    };
  }
  // 2. ローカル設定ファイル (.figma.json) を読み込む
  const configPath = path.join(__dirname, '.figma.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error('❌ .figma.json の読み込みに失敗しました:', e.message);
      process.exit(1);
    }
  }
  // 3. どちらもない場合はエラー
  console.error('❌ Figma トークンが見つかりません。');
  console.error('   次のいずれかの方法でトークンを設定してください:');
  console.error('');
  console.error('   方法 1: 環境変数');
  console.error('     export FIGMA_TOKEN=your_token_here');
  console.error('     node figma-sync.js');
  console.error('');
  console.error('   方法 2: .figma.json ファイル（.gitignore済み）');
  console.error('     {');
  console.error('       "token": "your_token_here",');
  console.error('       "fileId": "zRNcYf0XoaaxhP3WqGvwQP"');
  console.error('     }');
  process.exit(1);
}

const CONFIG = {
  ...loadConfig(),
  output: path.join(__dirname, 'figma-tokens.css'),
};
// ───────────────────────────────────────────────────────────────────────────

/** Figma API GET */
function figmaGet(endpoint) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.figma.com',
      path: `/v1/${endpoint}`,
      method: 'GET',
      headers: { 'X-Figma-Token': CONFIG.token },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Figma API error ${res.statusCode}: ${data}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** rgba → CSS hex or rgba文字列 */
function toCSS(color) {
  if (!color) return 'transparent';
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a ?? 1;
  if (a === 1) {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

/** CSS変数名に使える文字列へ変換 */
function toVarName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** ノードツリーを再帰的に走査してすべてのノードを返す */
function flattenNodes(node, acc = []) {
  acc.push(node);
  if (node.children) node.children.forEach((c) => flattenNodes(c, acc));
  return acc;
}

async function main() {
  console.log('📐 Figma ファイルを取得中...');

  // ファイル全体を取得
  const file = await figmaGet(`files/${CONFIG.fileId}`);
  console.log(`✅ ファイル名: ${file.name}`);

  // スタイル一覧を取得
  const stylesData = await figmaGet(`files/${CONFIG.fileId}/styles`);
  const stylesMeta = stylesData.meta?.styles ?? [];
  console.log(`🎨 スタイル数: ${stylesMeta.length}`);

  // ノード一覧から色・テキストスタイルのノードIDを収集
  const styleNodeIds = stylesMeta.map((s) => s.node_id);

  // スタイルノードを一括取得（最大 50 件ずつ）
  const chunks = [];
  for (let i = 0; i < styleNodeIds.length; i += 50) {
    chunks.push(styleNodeIds.slice(i, i + 50));
  }

  const styleNodes = {};
  for (const chunk of chunks) {
    const res = await figmaGet(
      `files/${CONFIG.fileId}/nodes?ids=${chunk.map(encodeURIComponent).join(',')}`
    );
    Object.assign(styleNodes, res.nodes ?? {});
  }

  // ─── CSS変数を組み立てる ─────────────────────────────────────────────────
  const colorVars = [];
  const fontVars  = [];
  const effectVars = [];

  for (const meta of stylesMeta) {
    const nodeId = meta.node_id;
    const node   = styleNodes[nodeId]?.document;
    if (!node) continue;

    const varName = toVarName(meta.name);

    // 色スタイル
    if (meta.style_type === 'FILL') {
      const fill = node.fills?.[0];
      if (fill?.type === 'SOLID') {
        colorVars.push(`  --color-${varName}: ${toCSS(fill.color)};`);
      } else if (fill?.type === 'GRADIENT_LINEAR') {
        const stops = (fill.gradientStops ?? [])
          .map((s) => `${toCSS(s.color)} ${Math.round(s.position * 100)}%`)
          .join(', ');
        colorVars.push(`  /* gradient */ --color-${varName}: linear-gradient(135deg, ${stops});`);
      }
    }

    // テキストスタイル
    if (meta.style_type === 'TEXT') {
      const style = node.style ?? {};
      if (style.fontFamily) {
        fontVars.push(`  --font-family-${varName}: '${style.fontFamily}', sans-serif;`);
      }
      if (style.fontSize) {
        fontVars.push(`  --font-size-${varName}: ${style.fontSize}px;`);
      }
      if (style.fontWeight) {
        fontVars.push(`  --font-weight-${varName}: ${style.fontWeight};`);
      }
      if (style.lineHeightPx) {
        fontVars.push(
          `  --line-height-${varName}: ${(style.lineHeightPx / style.fontSize).toFixed(2)};`
        );
      }
      if (style.letterSpacing && style.letterSpacing !== 0) {
        fontVars.push(`  --letter-spacing-${varName}: ${style.letterSpacing}px;`);
      }
    }

    // エフェクト（影など）
    if (meta.style_type === 'EFFECT') {
      const effect = node.effects?.[0];
      if (effect?.type === 'DROP_SHADOW') {
        const { offset = {}, radius = 0, spread = 0, color } = effect;
        effectVars.push(
          `  --shadow-${varName}: ${offset.x ?? 0}px ${offset.y ?? 0}px ${radius}px ${spread}px ${toCSS(color)};`
        );
      }
    }
  }

  // ─── ファイル全体のノードからスペーシング・サイズを抽出 ──────────────────
  const allNodes = flattenNodes(file.document);
  const spacingSet = new Set();
  const radiusSet  = new Set();

  for (const node of allNodes) {
    // スペーシング（Auto Layout のpadding / gap）
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing'].forEach((k) => {
      const v = node[k];
      if (typeof v === 'number' && v > 0) spacingSet.add(v);
    });
    // 角丸
    if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      radiusSet.add(node.cornerRadius);
    }
  }

  const spacingVars = [...spacingSet]
    .sort((a, b) => a - b)
    .map((v) => `  --spacing-${v}: ${v}px;`);

  const radiusVars = [...radiusSet]
    .sort((a, b) => a - b)
    .map((v) => `  --radius-${v}: ${v}px;`);

  // ─── CSS出力 ──────────────────────────────────────────────────────────────
  const sections = [];
  if (colorVars.length)   sections.push('  /* ── Colors ─────────────────── */\n' + colorVars.join('\n'));
  if (fontVars.length)    sections.push('  /* ── Typography ──────────────── */\n' + fontVars.join('\n'));
  if (effectVars.length)  sections.push('  /* ── Effects ─────────────────── */\n' + effectVars.join('\n'));
  if (spacingVars.length) sections.push('  /* ── Spacing ──────────────────── */\n' + spacingVars.join('\n'));
  if (radiusVars.length)  sections.push('  /* ── Border Radius ────────────── */\n' + radiusVars.join('\n'));

  const timestamp = new Date().toISOString();
  const css = `/*
 * figma-tokens.css
 * Auto-generated by figma-sync.js
 * Source: https://www.figma.com/design/${CONFIG.fileId}/
 * Generated: ${timestamp}
 *
 * ⚠️  このファイルは自動生成されます。直接編集しないでください。
 *    再生成するには: node figma-sync.js
 */

:root {
${sections.join('\n\n')}
}
`;

  fs.writeFileSync(CONFIG.output, css, 'utf8');

  console.log('');
  console.log('✨ 完了！');
  console.log(`📄 出力ファイル: ${CONFIG.output}`);
  console.log(`   色: ${colorVars.length} 件`);
  console.log(`   フォント変数: ${fontVars.length} 件`);
  console.log(`   エフェクト: ${effectVars.length} 件`);
  console.log(`   スペーシング: ${spacingVars.length} 件`);
  console.log(`   角丸: ${radiusVars.length} 件`);
}

main().catch((err) => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
