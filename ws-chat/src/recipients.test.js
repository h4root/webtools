import { describe, it, expect } from 'vitest';
import { recipientsFor } from '../public/recipients.js';

const device = (id) => ({ id, key: `key-${id}` });

describe('recipientsFor', () => {
  it('собирает устройства обеих сторон', () => {
    expect(recipientsFor([device('bob-1')], [device('my-1')])).toEqual([device('bob-1'), device('my-1')]);
  });

  it('не запечатывает одно устройство дважды', () => {
    expect(recipientsFor([device('one')], [device('one'), device('two')])).toEqual([device('one'), device('two')]);
  });

  it('пропускает записи без ключа или без опознавательного знака', () => {
    expect(recipientsFor([{ id: 'no-key' }, { key: 'no-id' }, null, device('ok')])).toEqual([device('ok')]);
  });

  it('переживает отсутствующие списки', () => {
    expect(recipientsFor(undefined, null, [])).toEqual([]);
  });

  it('оставляет только ключ и знак: лишнее в конверт не попадает', () => {
    expect(recipientsFor([{ id: 'a', key: 'k', device: 'MacBook Алисы' }])).toEqual([{ id: 'a', key: 'k' }]);
  });
});
