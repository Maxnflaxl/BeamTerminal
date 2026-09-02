export function parseMetadata(metadata) {
  // Strip the leading "STD:" prefix instead of shifting the first segment —
  // the previous shift() dropped the first real key (e.g. SCH_VER=1).
  const body = metadata.startsWith('STD:') ? metadata.slice(4) : metadata;
  return body.split(';').reduce((accumulator, segment) => {
    if (!segment) return accumulator;
    const data = segment.split(/=(.*)/s);
    if (!data[0]) return accumulator;
    return { ...accumulator, [data[0]]: data[1] };
  }, {});
}
