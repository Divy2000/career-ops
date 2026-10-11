// A command for run-stream tests: prints one line, then two more once the gate file exists, then exits 0.
export const GATED_LINES = ['scanning greenhouse', 'scanning ashby', 'scanning lever'] as const;

export const gatedScript = (gate: string) =>
  [
    "const fs = require('fs');",
    `console.log(${JSON.stringify(GATED_LINES[0])});`,
    `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(t); console.log(${JSON.stringify(GATED_LINES[1])}); console.log(${JSON.stringify(GATED_LINES[2])}); } }, 50);`,
  ].join(' ');
