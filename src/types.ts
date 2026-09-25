export type ComponentStatus = 'draft' | 'review' | 'published';
export type PreviewTheme = 'light' | 'dark';
export type PreviewDensity = 'compact' | 'regular' | 'spacious';
export type RevisionStatus = 'editing' | 'inReview';

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
  /** 仅在修订草稿内有意义：属性或交互变更后，示例等待复核。 */
  needsReReview?: boolean;
}

/** 修订草稿承载的可编辑内容；批准时一次性写回组件。 */
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

export interface ReviewLogEntry {
  at: string;
  action: 'submit' | 'approve' | 'reject';
  note: string;
}

export interface RevisionDraft {
  id: string;
  /** 打开草稿时组件所处的版本号。 */
  baseRevision: number;
  openedAt: string;
  status: RevisionStatus;
  /** 打开草稿时记下的属性、交互与无障碍文本等基线内容。 */
  baseline: RevisionContent;
  content: RevisionContent;
  /** 最近一次驳回意见。 */
  reviewNote: string;
  reviewLog: ReviewLogEntry[];
}

export interface ComponentSpec {
  id: string;
  name: string;
  category: string;
  status: ComponentStatus;
  purpose: string;
  usage: string;
  properties: PropertySpec[];
  states: string;
  keyboardBehavior: string;
  screenReader: string;
  disabledScenarios: string;
  interactionSignature: string;
  examples: ComponentExample[];
  revision: number;
  updatedAt: string;
  snapshots: ComponentSnapshot[];
  /** 同一组件最多一份进行中的修订草稿。 */
  activeRevision: RevisionDraft | null;
}

export interface ComponentSnapshot {
  revision: number;
  savedAt: string;
  reason: string;
  component: Omit<ComponentSpec, 'snapshots'>;
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
  field: 'properties' | 'examples' | 'keyboard' | 'screenReader' | 'revision';
}

export interface DiffRow {
  field: string;
  before: string;
  after: string;
}
