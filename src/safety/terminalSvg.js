/**
 * A static terminal frame. The demo and the safety report embed this so a
 * reviewer can see the numbers without running the commands.
 *
 * @module safety/terminalSvg
 */

/**
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {string} title
 * @param {string[]} lines
 * @returns {string}
 */
export function terminalSvg(title, lines) {
  const width = 920;
  const lineHeight = 22;
  const height = 64 + lines.length * lineHeight;
  const body = lines.map((line, index) => {
    const y = 56 + index * lineHeight;
    return `  <text class="line" x="24" y="${y}">${escapeXml(line)}</text>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
  <title>${escapeXml(title)}</title>
  <style>
    .bg { fill: #0f172a; }
    .bar { fill: #1e293b; }
    .title { fill: #e2e8f0; font: 600 14px ui-monospace, Menlo, Consolas, monospace; }
    .line { fill: #d1fae5; font: 14px ui-monospace, Menlo, Consolas, monospace; }
  </style>
  <rect class="bg" width="${width}" height="${height}" rx="12"/>
  <rect class="bar" width="${width}" height="36"/>
  <circle cx="20" cy="18" r="6" fill="#f87171"/>
  <circle cx="40" cy="18" r="6" fill="#fbbf24"/>
  <circle cx="60" cy="18" r="6" fill="#34d399"/>
  <text class="title" x="80" y="23">${escapeXml(title)}</text>
${body}
</svg>
`;
}
