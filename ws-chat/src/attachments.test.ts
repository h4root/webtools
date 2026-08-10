import { describe, it, expect, beforeEach } from 'vitest';
import { attachmentDisposition, describeUpload, planDownload, safeName, UploadQuota } from './attachments.ts';

describe('safeName', () => {
  it('раскрывает процентное кодирование', () => {
    expect(safeName(encodeURIComponent('отчёт за год.pdf'))).toBe('отчёт за год.pdf');
  });

  it('выбрасывает разделители пути и переводы строк', () => {
    expect(safeName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeName('c:\\windows\\system32')).toBe('c:_windows_system32');
    expect(safeName('имя\r\nContent-Length: 0')).toBe('имя__Content-Length: 0');
  });

  it('не падает на битом кодировании и не отдаёт пустое имя', () => {
    expect(safeName('%E0%A4%A')).toBe('%E0%A4%A');
    expect(safeName('')).toBe('file');
    expect(safeName('///')).toBe('___');
  });

  it('обрезает слишком длинное', () => {
    expect(safeName('я'.repeat(400))).toHaveLength(255);
  });
});

describe('attachmentDisposition', () => {
  it('картинки показывает встроенно', () => {
    expect(attachmentDisposition('image/png')).toMatchObject({ inline: true, contentType: 'image/png' });
    expect(attachmentDisposition('image/webp').inline).toBe(true);
  });

  it('всё остальное отдаёт вложением и без исходного типа', () => {
    for (const mime of ['image/svg+xml', 'text/html', 'application/pdf', 'text/plain']) {
      expect(attachmentDisposition(mime)).toMatchObject({ inline: false, contentType: 'application/octet-stream' });
    }
  });

  it('не ведётся на приписки к типу', () => {
    expect(attachmentDisposition('image/png; charset=utf-8').inline).toBe(false);
    expect(attachmentDisposition('IMAGE/PNG').inline).toBe(true);
  });

  it('собирает заголовок с именем в utf-8', () => {
    const header = attachmentDisposition('image/png').header('кот.png');
    expect(header).toBe("inline; filename*=UTF-8''%D0%BA%D0%BE%D1%82.png");
    expect(header).not.toContain('\n');
  });
});

describe('describeUpload', () => {
  it('берёт имя и тип из заголовков', () => {
    expect(describeUpload({ 'x-filename': encodeURIComponent('кот.png'), 'content-type': 'image/png' })).toEqual({
      name: 'кот.png',
      mime: 'image/png',
    });
  });

  it('подставляет умолчания, когда заголовков нет', () => {
    expect(describeUpload({})).toEqual({ name: 'file', mime: 'application/octet-stream' });
  });

  it('не даёт разрастись типу', () => {
    expect(describeUpload({ 'content-type': 'x'.repeat(500) }).mime).toHaveLength(128);
  });
});

describe('planDownload', () => {
  const attachment = { id: 'a'.repeat(32), name: 'кот.png', size: 4, mime: 'image/png' };

  it('отказывает, когда сообщения с этим вложением не видно', () => {
    expect(planDownload(null, null)).toEqual({ status: 404, error: 'not-found' });
  });

  it('сообщает, что блоб пропал, если ссылка есть, а файла нет', () => {
    expect(planDownload(attachment, null)).toEqual({ status: 410, error: 'gone' });
  });

  it('отдаёт файл с заголовками, когда доступ есть', () => {
    const plan = planDownload(attachment, { mime: 'image/png' });
    expect(plan).toMatchObject({ status: 200, contentType: 'image/png' });
    expect(plan.status === 200 && plan.disposition).toContain('inline');
  });

  it('доверяет типу блоба, а не записи в сообщении', () => {
    const plan = planDownload({ ...attachment, mime: 'image/png' }, { mime: 'text/html' });
    expect(plan).toMatchObject({ status: 200, contentType: 'application/octet-stream' });
    expect(plan.status === 200 && plan.disposition).toContain('attachment');
  });
});

describe('UploadQuota', () => {
  let quota: UploadQuota;

  beforeEach(() => {
    quota = new UploadQuota(3, 1000);
  });

  it('пропускает в пределах и осаживает сверх', () => {
    for (let i = 0; i < 3; i++) expect(quota.allow('a')).toBe(true);
    expect(quota.allow('a')).toBe(false);
    expect(quota.allow('b')).toBe(true);
  });

  it('открывает заново после окна', () => {
    for (let i = 0; i < 4; i++) quota.allow('a');
    quota.forget('a');
    expect(quota.allow('a')).toBe(true);
  });

  it('не копит записи ушедших', () => {
    quota.allow('a');
    quota.allow('b');
    quota.forget('a');
    expect(quota.size()).toBe(1);
  });
});
