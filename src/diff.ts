import type { ComponentSnapshot, ComponentSpec, DiffRow, RevisionDraft } from './types';

/** 参与差异对比的内容字段（组件与修订草稿共用）。 */
type DiffableContent = Pick<
  ComponentSpec,
  | 'name'
  | 'category'
  | 'purpose'
  | 'usage'
  | 'states'
  | 'keyboardBehavior'
  | 'screenReader'
  | 'disabledScenarios'
  | 'interactionSignature'
  | 'properties'
  | 'examples'
>;

const contentFields: Array<keyof Omit<DiffableContent, 'properties' | 'examples'>> = [
  'name', 'category', 'purpose', 'usage', 'states', 'keyboardBehavior', 'screenReader', 'disabledScenarios', 'interactionSignature'
];

const format = (value: unknown): string => {
  if (Array.isArray(value)) return value.map((item) => JSON.stringify(item)).join('\n');
  return String(value ?? '');
};

export function diffContents(before: DiffableContent, after: DiffableContent): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const field of contentFields) {
    const beforeValue = format(before[field]);
    const afterValue = format(after[field]);
    if (beforeValue !== afterValue) rows.push({ field: String(field), before: beforeValue, after: afterValue });
  }
  const beforeProperties = format(before.properties);
  const afterProperties = format(after.properties);
  if (beforeProperties !== afterProperties) rows.push({ field: 'properties', before: beforeProperties, after: afterProperties });
  const beforeExamples = format(before.examples);
  const afterExamples = format(after.examples);
  if (beforeExamples !== afterExamples) rows.push({ field: 'examples', before: beforeExamples, after: afterExamples });
  return rows;
}

export function diffAgainstSnapshot(component: ComponentSpec, snapshot?: ComponentSnapshot): DiffRow[] {
  if (!snapshot) return [];
  const rows = diffContents(snapshot.component, component);
  if (snapshot.component.status !== component.status) {
    rows.unshift({ field: 'status', before: snapshot.component.status, after: component.status });
  }
  return rows;
}

/** 修订草稿与打开时基线的差异，用于送审与审核。 */
export function diffRevision(draft: RevisionDraft): DiffRow[] {
  return diffContents(draft.baseline, draft.content);
}

/** 比较两个历史快照（例如修订批准前 / 批准后）。 */
export function diffSnapshots(older: ComponentSnapshot, newer: ComponentSnapshot): DiffRow[] {
  return diffContents(older.component, newer.component);
}
