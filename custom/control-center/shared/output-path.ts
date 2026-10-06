// The rule for a file the app names under the data root's output/ (the CV PDF the prefill attaches, the HTML a re-render
// reads, a cover letter): the server's action schemas and the Apply page check the same thing. People drop files there
// by hand ("Acme Resume.pdf"), so any name a file can have is fine; what is refused is a path that is not one file under
// output/ (an empty, "." or ".." segment, an absolute path) or a name no command line should carry (a control character).
// The server still resolves the file and refuses one whose real path leaves output/ (resolveOutputFile).
export const OUTPUT_PATH_MAX = 512;

/** Why `rel` is not a `what` under output/, or null when it is one. */
export function outputFileProblem(rel: string, ext: RegExp, what: string): string | null {
  if (rel.length > OUTPUT_PATH_MAX) return `a path longer than ${OUTPUT_PATH_MAX} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rel)) return 'a file name with a control character';
  const [top, ...rest] = rel.split('/');
  if (top !== 'output' || rest.length === 0) return 'a file under output/';
  if (rest.some((seg) => seg === '' || seg === '.' || seg === '..')) return 'one file under output/, with no empty, "." or ".." folder';
  return ext.test(rel) ? null : what;
}
