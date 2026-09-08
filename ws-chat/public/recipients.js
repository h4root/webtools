export function recipientsFor(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const device of list ?? []) {
      if (!device?.id || !device?.key || seen.has(device.id)) continue;
      seen.set(device.id, { id: device.id, key: device.key });
    }
  }
  return [...seen.values()];
}
