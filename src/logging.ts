import kleur from 'kleur';

const start = Date.now();

function ts(): string {
  const s = Math.floor((Date.now() - start) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export const log = {
  banner(text: string): void {
    const bar = '━'.repeat(Math.max(8, 68 - text.length));
    console.log(kleur.bold().cyan(`\n━━━ ${text} ${bar}`));
  },
  info(msg: string): void {
    console.log(kleur.gray(`[${ts()}]`) + ' ' + msg);
  },
  step(msg: string): void {
    console.log(kleur.gray(`[${ts()}]`) + ' ' + kleur.blue('▸') + ' ' + msg);
  },
  ok(msg: string): void {
    console.log(kleur.gray(`[${ts()}]`) + ' ' + kleur.green('✓') + ' ' + msg);
  },
  warn(msg: string): void {
    console.log(kleur.gray(`[${ts()}]`) + ' ' + kleur.yellow('⚠') + ' ' + msg);
  },
  err(msg: string): void {
    console.log(kleur.gray(`[${ts()}]`) + ' ' + kleur.red('✗') + ' ' + msg);
  },
  dim(msg: string): void {
    console.log(kleur.gray(`[${ts()}] ${msg}`));
  },
  raw(msg: string): void {
    console.log(msg);
  },
};
