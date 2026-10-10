import { type DefaultTreeAdapterMap, defaultTreeAdapter, Parser } from 'parse5';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 4096;

/** Remove complete secret subtrees while preserving the remaining original source. */
export function redactHtmlSecrets(source: string): string {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error('Rich text exceeds the maximum source size');
  }
  let openElements = 0;
  const parser = Parser.getFragmentParser<DefaultTreeAdapterMap>(null, {
    sourceCodeLocationInfo: true,
    treeAdapter: {
      ...defaultTreeAdapter,
      onItemPush() {
        openElements += 1;
        if (openElements > MAX_DEPTH + 1) {
          throw new Error('Rich text exceeds the maximum nesting depth');
        }
      },
      onItemPop() {
        openElements -= 1;
      },
    },
  });
  parser.tokenizer.write(source, true);
  // Traverse the fragment's synthetic root directly. getFragment() transfers every
  // child with an array splice, making wide documents quadratic with this adapter.
  const root = defaultTreeAdapter.getFirstChild(parser.document);
  if (root == null) {
    throw new Error('Rich text fragment has no root');
  }
  const stack: DefaultTreeAdapterMap['node'][] = [root];
  const ranges: Array<{ start: number; end: number }> = [];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    if (++visited > MAX_NODES) {
      throw new Error('Rich text exceeds the maximum node count');
    }
    if ('tagName' in node) {
      const classes = node.attrs.find((attribute) => attribute.name === 'class')?.value;
      if (classes?.split(/\s+/).includes('secret')) {
        const location = node.sourceCodeLocation;
        if (
          !location ||
          !Number.isSafeInteger(location.startOffset) ||
          !Number.isSafeInteger(location.endOffset) ||
          location.startOffset < 0 ||
          location.endOffset <= location.startOffset ||
          location.endOffset > source.length
        ) {
          throw new Error('Secret rich text has invalid source boundaries');
        }
        ranges.push({ start: location.startOffset, end: location.endOffset });
      }
      if (node.tagName === 'template' && 'content' in node) {
        stack.push(node.content);
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) {
        stack.push(child);
      }
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  const visible: string[] = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.start > offset) {
      visible.push(source.slice(offset, range.start));
    }
    offset = Math.max(offset, range.end);
  }
  visible.push(source.slice(offset));
  return visible.join('');
}
