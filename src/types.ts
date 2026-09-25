export type ComponentStatus = 'draft' | 'published';
export type RevisionPhase = 'editing' | 'inReview';
export type DisplayStatus = 'draft' | 'published' | 'revising' | 'pending-recheck' | 'in-review';
export type PreviewTheme = 'light' | 'dark';
export type PreviewDensity = 'compact' | 'regular' | 'spacious';

export interface PropertySpec {
  id: string;
  name: string;
  type: string;
  required: boolean;
  defaultValue: string;
  description: string;
}

export interface ComponentExample {
  id: string;
  title: string;
  code: string;
  propertyIds: string[];
  stale: boolean;
  staleReason: string;
  createdFromRevision: number;
}

/** 组件契约中可被修订的内容字段。 */
export interface RevisionContent {
  name: string;
  category: string;
  purpose: string;
  usage: string;
  properties: PropertySpec[];
  states: string;
  keyboardBehavior: string;
  screenReader: string;
  disabledScenarios: string;
  interactionSignature: string;
  examples: ComponentExample[];
}

/**
 * 修订草稿：已发布组件的修改必须先收进草稿。
 * 打开时用 base 记下修订前的属性、交互签名与无障碍文本；
 * content 是工作副本；批准时一次性写回组件。
 */
export interface RevisionDraft {
  id: string;
  phase: RevisionPhase;
  baseRevision: number;
  base: RevisionContent;
  content: RevisionContent;
  /** 受属性或交互修改影响、等待复核的示例。复核清零前不能送审。 */
  pendingExampleIds: string[];
  /** 驳回时填写的审核意见，退回后继续编辑可见。 */
  reviewComment: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

export interface ComponentSpec extends RevisionContent {
  id: string;
  status: ComponentStatus;
  revision: number;
  updatedAt: string;
  snapshots: ComponentSnapshot[];
  /** 同一组件最多一份进行中的修订。 */
  activeRevision: RevisionDraft | null;
}

export interface ComponentSnapshot {
  revision: number;
  savedAt: string;
  reason: string;
  component: Omit<ComponentSpec, 'snapshots' | 'activeRevision'>;
}

export interface WorkspaceState {
  components: ComponentSpec[];
  selectedId: string;
}

export interface ValidationIssue {
  id: string;
  level: 'error' | 'warning' | 'info';
  componentId: string;
  target: string;
  message: string;
  field: 'properties' | 'examples' | 'keyboard' | 'screenReader';
}

export interface DiffRow {
  field: string;
  before: string;
  after: string;
}
