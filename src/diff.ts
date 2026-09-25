import type { ComponentSnapshot, ComponentSpec, DiffRow, RevisionContent } from './types';

const selectedFields: Array<keyof RevisionContent> = [
  'name', 'category', 'purpose', 'usage', 'states', 'keyboardBehavior', 'screenReader', 'disabledScenarios', 'interactionSignature'
];

const fieldLabels: Record<string, string> = {
  name: '名称',
  category: '分类',
  purpose: '用途',
  usage: '使用规则',
  states: '状态说明',
  keyboardBehavior: '键盘行为',
  screenReader: '读屏说明',
  disabledScenarios: '禁用场景',
  interactionSignature: '交互签名',
  properties: '属性',
  examples: '示例'
};

const format = (value: unknown): string => {
  if (Array.isArray(value)) return value.map((item) => JSON.stringify(item)).join('\n');
  return String(value ?? '');
};

/** 比较两份契约内容（如修订基线与修订工作副本），返回逐字段差异。 */
export function diffContents(before: RevisionContent, after: RevisionContent): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const field of selectedFields) {
    const beforeValue = format(before[field]);
    const afterValue = format(after[field]);
    if (beforeValue !== afterValue) rows.push({ field: fieldLabels[field] ?? String(field), before: beforeValue, after: afterValue });
  }
  const beforeProperties = format(before.properties);
  const afterProperties = format(after.properties);
  if (beforeProperties !== afterProperties) rows.push({ field: fieldLabels.properties, before: beforeProperties, after: afterProperties });
  const beforeExamples = format(before.examples);
  const afterExamples = format(after.examples);
  if (beforeExamples !== afterExamples) rows.push({ field: fieldLabels.examples, before: beforeExamples, after: afterExamples });
  return rows;
}

export function diffAgainstSnapshot(component: ComponentSpec, snapshot?: ComponentSnapshot): DiffRow[] {
  if (!snapshot) return [];
  return diffContents(snapshot.component, component);
}
