import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Прямая запись поверх файла оставляет обрезанный JSON, если процесс умрёт на
// середине, а отличить такой файл от валидного уже нельзя.
export function writeJsonAtomic(file: string, data: unknown, mode?: number): void {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(data), mode === undefined ? undefined : { mode });
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* временного файла может и не быть */
    }
    throw error;
  }
}

// null — файла нет. Битый файл бросает исключение: вызывающий сам решает, что
// с ним делать, молча стартовать с пустого нельзя.
export function readJson<T>(file: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(raw) as T;
}
