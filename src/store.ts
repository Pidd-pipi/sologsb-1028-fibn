import { createInitialState } from './data';
import type {
  ComponentSnapshot,
  ComponentSpec,
  DisplayStatus,
  RevisionContent,
  RevisionDraft,
  ValidationIssue,
  WorkspaceState
} from './types';

const STORAGE_KEY = 'sologsb-1028-workspace-v2';
const LEGACY_STORAGE_KEY = 'sologsb-1028-workspace-v1';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();

/** 修改这些字段视为交互契约变化，草稿内所有示例都要复核。 */
const INTERACTION_FIELDS: Array<keyof RevisionContent> = ['interactionSignature', 'keyboardBehavior'];
/** 修改这些属性字段视为属性契约变化，引用该属性的示例要复核。 */
const PROPERTY_CONTRACT_FIELDS = ['name', 'type', 'required', 'defaultValue'] as const;

/** 提取组件当前发布的内容，作为修订基线或工作副本。 */
export const pickContent = (component: ComponentSpec): RevisionContent => ({
  name: component.name,
  category: component.category,
  purpose: component.purpose,
  usage: component.usage,
  properties: clone(component.properties),
  states: component.states,
  keyboardBehavior: component.keyboardBehavior,
  screenReader: component.screenReader,
  disabledScenarios: component.disabledScenarios,
  interactionSignature: component.interactionSignature,
  examples: clone(component.examples)
});

/** 目录展示状态：草稿 / 已发布 / 修订中 / 待复核 / 待审。 */
export const displayStatus = (component: ComponentSpec): DisplayStatus => {
  if (component.status === 'draft') return 'draft';
  const revision = component.activeRevision;
  if (!revision) return 'published';
  if (revision.phase === 'inReview') return 'in-review';
  return revision.pendingExampleIds.length ? 'pending-recheck' : 'revising';
};

interface EditTarget {
  component: ComponentSpec;
  /** 可写内容；为 null 表示已发布且没有编辑中的修订，内容冻结。 */
  content: RevisionContent | null;
  revision: RevisionDraft | null;
}

export class SpecStore extends EventTarget {
  state: WorkspaceState;
  private undoStack: WorkspaceState[] = [];
  private redoStack: WorkspaceState[] = [];
  private lastAction = '';

  constructor() {
    super();
    this.state = this.load();
  }

  get selected(): ComponentSpec | undefined {
    return this.state.components.find((item) => item.id === this.state.selectedId);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get lastUndoLabel() { return this.lastAction; }

  select(id: string) {
    if (!this.state.components.some((item) => item.id === id)) return;
    this.state = { ...this.state, selectedId: id };
    this.persist(false);
    this.emit();
  }

  addComponent() {
    const id = uid('component');
    const component: ComponentSpec = {
      id,
      name: 'Untitled component',
      category: 'Uncategorised',
      status: 'draft',
      purpose: '说明该组件解决的用户问题。',
      usage: '说明何时使用、何时不要使用。',
      properties: [],
      states: 'default、hover、focus-visible、disabled。',
      keyboardBehavior: '记录 Tab、Enter、Space、方向键和 Esc 等行为。',
      screenReader: '记录角色、名称、状态和动态播报。',
      disabledScenarios: '记录不应使用该组件的场景。',
      interactionSignature: '',
      examples: [],
      revision: 1,
      updatedAt: now(),
      snapshots: [],
      activeRevision: null
    };
    this.commit('新建组件', (state) => {
      state.components.unshift(component);
      state.selectedId = id;
    });
  }

  updateComponent(patch: Partial<RevisionContent>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑组件', (state) => {
      const target = this.locate(state, selected.id);
      if (!target?.content) return;
      Object.assign(target.content, patch);
      this.touch(target);
      if (!INTERACTION_FIELDS.some((field) => field in patch)) return;
      if (target.revision) {
        this.markExamplesPending(target.revision, target.revision.content.examples.map((example) => example.id), '交互行为或键盘说明已修改，关联示例需要复核。');
      } else {
        target.content.examples.forEach((example) => {
          example.stale = true;
          example.staleReason = '组件交互或属性契约已修改，示例需要重新验证。';
        });
      }
    });
  }

  addProperty() {
    const selected = this.selected;
    if (!selected) return;
    this.commit('新增属性', (state) => {
      const target = this.locate(state, selected.id);
      if (!target?.content) return;
      target.content.properties.push({
        id: uid('property'),
        name: 'newProperty',
        type: 'string',
        required: false,
        defaultValue: '',
        description: '描述该属性对开发者和用户的影响。'
      });
      this.touch(target);
    });
  }

  updateProperty(propertyId: string, patch: Partial<ComponentSpec['properties'][number]>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑属性', (state) => {
      const target = this.locate(state, selected.id);
      if (!target?.content) return;
      const property = target.content.properties.find((item) => item.id === propertyId);
      if (!property) return;
      const previousName = property.name;
      const contractTouched = PROPERTY_CONTRACT_FIELDS.some((field) => field in patch && patch[field] !== property[field]);
      Object.assign(property, patch);
      this.touch(target);
      if (!contractTouched || !target.revision) return;
      const affected = target.revision.content.examples
        .filter((example) => example.propertyIds.includes(propertyId) || example.code.includes(previousName) || example.code.includes(property.name))
        .map((example) => example.id);
      this.markExamplesPending(target.revision, affected, `属性 ${property.name} 的契约已修改，引用它的示例需要复核。`);
    });
  }

  removeProperty(propertyId: string) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('删除属性', (state) => {
      const target = this.locate(state, selected.id);
      if (!target?.content) return;
      const property = target.content.properties.find((item) => item.id === propertyId);
      if (!property) return;
      target.content.properties = target.content.properties.filter((item) => item.id !== propertyId);
      const reason = `属性 ${property.name} 已删除，示例代码或说明仍可能引用它。`;
      const affected = target.content.examples
        .filter((example) => example.propertyIds.includes(propertyId) || example.code.includes(property.name))
        .map((example) => example.id);
      if (target.revision) {
        this.markExamplesPending(target.revision, affected, reason);
      } else {
        target.content.examples.forEach((example) => {
          if (affected.includes(example.id)) {
            example.stale = true;
            example.staleReason = reason;
          }
        });
      }
      this.touch(target);
    });
  }

  addExample() {
    const selected = this.selected;
    if (!selected) return;
    this.commit('新增示例', (state) => {
      const target = this.locate(state, selected.id);
      if (!target?.content) return;
      const tag = target.content.name.toLowerCase().replaceAll(' ', '-');
      target.content.examples.push({
        id: uid('example'),
        title: '新示例',
        code: `<${tag}>示例</${tag}>`,
        propertyIds: [],
        stale: false,
        staleReason: '',
        createdFromRevision: target.component.revision
      });
      this.touch(target);
    });
  }

  updateExample(exampleId: string, patch: Partial<ComponentSpec['examples'][number]>) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('编辑示例', (state) => {
      const target = this.locate(state, selected.id);
      if (!target?.content) return;
      const example = target.content.examples.find((item) => item.id === exampleId);
      if (example) Object.assign(example, patch);
      this.touch(target);
    });
  }

  removeExample(exampleId: string) {
    const selected = this.selected;
    if (!selected) return;
    this.commit('删除示例', (state) => {
      const target = this.locate(state, selected.id);
      if (!target?.content) return;
      target.content.examples = target.content.examples.filter((item) => item.id !== exampleId);
      if (target.revision) {
        target.revision.pendingExampleIds = target.revision.pendingExampleIds.filter((id) => id !== exampleId);
      }
      this.touch(target);
    });
  }

  /** 打开修订草稿：记录当前属性、交互签名与无障碍文本作为修订前基线。 */
  startRevision() {
    const selected = this.selected;
    if (!selected || selected.status !== 'published' || selected.activeRevision) return;
    this.commit('打开修订草稿', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target || target.status !== 'published' || target.activeRevision) return;
      const at = now();
      target.activeRevision = {
        id: uid('revision'),
        phase: 'editing',
        baseRevision: target.revision,
        base: pickContent(target),
        content: pickContent(target),
        pendingExampleIds: target.examples.filter((example) => example.stale).map((example) => example.id),
        reviewComment: '',
        createdAt: at,
        updatedAt: at,
        submittedAt: null
      };
    });
  }

  /** 送审：仍有待复核示例时拒绝提交。 */
  submitRevision(): boolean {
    const selected = this.selected;
    const revision = selected?.activeRevision;
    if (!selected || !revision || revision.phase !== 'editing' || revision.pendingExampleIds.length > 0) return false;
    this.commit('送审修订', (state) => {
      const target = state.components.find((item) => item.id === selected.id)?.activeRevision;
      if (!target || target.phase !== 'editing' || target.pendingExampleIds.length > 0) return;
      target.phase = 'inReview';
      target.submittedAt = now();
      target.updatedAt = now();
    });
    return true;
  }

  /** 批准：一次性写入组件，并留下修订前、修订后两份快照。 */
  approveRevision() {
    const selected = this.selected;
    if (!selected?.activeRevision || selected.activeRevision.phase !== 'inReview') return;
    this.commit('批准修订并写入', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      const revision = target?.activeRevision;
      if (!target || !revision || revision.phase !== 'inReview') return;
      const at = now();
      const { snapshots: _beforeSnapshots, activeRevision: _beforeRevision, ...beforeComponent } = clone(target);
      const beforeSnapshot: ComponentSnapshot = {
        revision: target.revision,
        savedAt: at,
        reason: `修订前 · 修订单基于 r${revision.baseRevision}`,
        component: beforeComponent
      };
      Object.assign(target, clone(revision.content));
      target.revision += 1;
      target.updatedAt = at;
      target.examples.forEach((example) => {
        example.stale = false;
        example.staleReason = '';
        example.createdFromRevision = target.revision;
      });
      const { snapshots: _afterSnapshots, activeRevision: _afterRevision, ...afterComponent } = clone(target);
      const afterSnapshot: ComponentSnapshot = {
        revision: target.revision,
        savedAt: at,
        reason: '修订后 · 批准一次性写入',
        component: afterComponent
      };
      target.snapshots = [afterSnapshot, beforeSnapshot, ...target.snapshots].slice(0, 12);
      target.activeRevision = null;
    });
  }

  /** 驳回：必须填写意见，草稿退回编辑中状态。 */
  rejectRevision(comment: string): boolean {
    const selected = this.selected;
    const revision = selected?.activeRevision;
    const trimmed = comment.trim();
    if (!selected || !revision || revision.phase !== 'inReview' || !trimmed) return false;
    this.commit('驳回修订', (state) => {
      const target = state.components.find((item) => item.id === selected.id)?.activeRevision;
      if (!target || target.phase !== 'inReview') return;
      target.phase = 'editing';
      target.reviewComment = trimmed;
      target.submittedAt = null;
      target.updatedAt = now();
    });
    return true;
  }

  discardRevision() {
    const selected = this.selected;
    if (!selected?.activeRevision) return;
    this.commit('放弃修订草稿', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (target) target.activeRevision = null;
    });
  }

  /** 复核单个示例：从待复核列表移除并清除失效标记。 */
  confirmExample(exampleId: string) {
    const selected = this.selected;
    if (!selected?.activeRevision) return;
    this.commit('确认示例复核', (state) => {
      const revision = state.components.find((item) => item.id === selected.id)?.activeRevision;
      if (!revision || revision.phase !== 'editing') return;
      revision.pendingExampleIds = revision.pendingExampleIds.filter((id) => id !== exampleId);
      const example = revision.content.examples.find((item) => item.id === exampleId);
      if (example) {
        example.stale = false;
        example.staleReason = '';
      }
      revision.updatedAt = now();
    });
  }

  confirmAllExamples() {
    const selected = this.selected;
    if (!selected?.activeRevision) return;
    this.commit('全部示例复核完成', (state) => {
      const revision = state.components.find((item) => item.id === selected.id)?.activeRevision;
      if (!revision || revision.phase !== 'editing') return;
      revision.pendingExampleIds = [];
      revision.content.examples.forEach((example) => {
        example.stale = false;
        example.staleReason = '';
      });
      revision.updatedAt = now();
    });
  }

  /** 首次发布：草稿组件转为已发布，之后修改必须走修订草稿。 */
  publishComponent() {
    const selected = this.selected;
    if (!selected || selected.status !== 'draft') return;
    this.commit('发布组件', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target || target.status !== 'draft') return;
      const at = now();
      target.status = 'published';
      target.updatedAt = at;
      const { snapshots: _snapshots, activeRevision: _revision, ...component } = clone(target);
      target.snapshots.unshift({ revision: target.revision, savedAt: at, reason: '首次发布', component });
      target.snapshots = target.snapshots.slice(0, 12);
    });
  }

  createSnapshot(reason = '手动版本') {
    const selected = this.selected;
    if (!selected) return;
    this.commit('创建版本快照', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const { snapshots: _snapshots, activeRevision: _revision, ...component } = clone(target);
      const snapshot: ComponentSnapshot = {
        revision: target.revision,
        savedAt: now(),
        reason,
        component
      };
      target.snapshots.unshift(snapshot);
      target.snapshots = target.snapshots.slice(0, 12);
      target.revision += 1;
      target.updatedAt = now();
    });
  }

  /** 未发布草稿的示例迁移；已发布组件请使用修订草稿的复核流程。 */
  migrateExamples() {
    const selected = this.selected;
    if (!selected || selected.status !== 'draft') return;
    this.commit('迁移示例到当前版本', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const activePropertyIds = new Set(target.properties.map((item) => item.id));
      target.examples.forEach((example) => {
        example.propertyIds = example.propertyIds.filter((id) => activePropertyIds.has(id));
        example.stale = false;
        example.staleReason = '';
        example.createdFromRevision = target.revision;
      });
      target.revision += 1;
      target.updatedAt = now();
    });
  }

  validate(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const component of this.state.components) {
      const revision = component.activeRevision;
      const content: RevisionContent = revision ? revision.content : component;
      const names = new Map<string, number>();
      content.properties.forEach((property) => names.set(property.name.trim(), (names.get(property.name.trim()) ?? 0) + 1));
      for (const [name, count] of names) {
        if (name && count > 1) {
          issues.push({ id: `${component.id}-duplicate-${name}`, level: 'error', componentId: component.id, target: content.name, message: `属性名称 ${name} 重复。`, field: 'properties' });
        }
      }
      content.examples.forEach((example) => {
        const missingReferences = example.propertyIds.filter((id) => !content.properties.some((property) => property.id === id));
        if (revision?.pendingExampleIds.includes(example.id)) {
          issues.push({ id: `${component.id}-${example.id}-pending`, level: 'warning', componentId: component.id, target: example.title, message: example.staleReason || '示例受属性或交互修改影响，等待复核。', field: 'examples' });
        } else if (example.stale || missingReferences.length) {
          issues.push({ id: `${component.id}-${example.id}-stale`, level: 'warning', componentId: component.id, target: example.title, message: example.staleReason || '示例引用了已删除属性。', field: 'examples' });
        }
        if (!example.code.trim()) {
          issues.push({ id: `${component.id}-${example.id}-empty`, level: 'error', componentId: component.id, target: example.title, message: '示例代码不能为空。', field: 'examples' });
        }
      });
      if (!content.keyboardBehavior.trim()) {
        issues.push({ id: `${component.id}-keyboard`, level: 'error', componentId: component.id, target: content.name, message: '缺少键盘行为说明。', field: 'keyboard' });
      }
      if (!content.screenReader.trim()) {
        issues.push({ id: `${component.id}-screenreader`, level: 'error', componentId: component.id, target: content.name, message: '缺少读屏说明。', field: 'screenReader' });
      }
      if (revision) {
        if (revision.phase === 'editing' && revision.pendingExampleIds.length) {
          issues.push({ id: `${component.id}-revision-pending`, level: 'warning', componentId: component.id, target: content.name, message: `修订草稿中有 ${revision.pendingExampleIds.length} 个示例待复核，复核完成前不能送审。`, field: 'examples' });
        }
        if (revision.phase === 'editing' && revision.reviewComment) {
          issues.push({ id: `${component.id}-revision-rejected`, level: 'info', componentId: component.id, target: content.name, message: `修订被驳回：${revision.reviewComment}`, field: 'examples' });
        }
        if (revision.phase === 'inReview') {
          issues.push({ id: `${component.id}-revision-review`, level: 'info', componentId: component.id, target: content.name, message: '修订已送审，草稿已冻结，等待批准或驳回。', field: 'examples' });
        }
      } else if (component.status === 'draft' && content.examples.some((example) => example.createdFromRevision < component.revision) && content.examples.length) {
        issues.push({ id: `${component.id}-contract`, level: 'info', componentId: component.id, target: content.name, message: '属性契约或交互签名发生变化，建议创建快照并迁移示例。', field: 'properties' });
      }
    }
    return issues;
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.state));
    this.state = previous;
    this.persist(false);
    this.emit();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.state));
    this.state = next;
    this.persist(false);
    this.emit();
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
    this.state = createInitialState();
    this.persist(false);
    this.emit();
  }

  /** 定位选中组件的可写内容：草稿直接写组件，已发布组件写修订工作副本，其余情况冻结。 */
  private locate(state: WorkspaceState, componentId: string): EditTarget | null {
    const component = state.components.find((item) => item.id === componentId);
    if (!component) return null;
    if (component.status === 'published') {
      const revision = component.activeRevision;
      if (!revision || revision.phase !== 'editing') return { component, content: null, revision };
      return { component, content: revision.content, revision };
    }
    return { component, content: component, revision: null };
  }

  private touch(target: EditTarget) {
    const at = now();
    if (target.revision) target.revision.updatedAt = at;
    else target.component.updatedAt = at;
  }

  private markExamplesPending(revision: RevisionDraft, exampleIds: string[], reason: string) {
    if (!exampleIds.length) return;
    const pending = new Set(revision.pendingExampleIds);
    revision.content.examples.forEach((example) => {
      if (!exampleIds.includes(example.id)) return;
      pending.add(example.id);
      example.stale = true;
      example.staleReason = reason;
    });
    revision.pendingExampleIds = [...pending];
  }

  private commit(label: string, mutator: (state: WorkspaceState) => void) {
    const before = clone(this.state);
    const next = clone(this.state);
    mutator(next);
    this.undoStack.push(before);
    this.undoStack = this.undoStack.slice(-40);
    this.redoStack = [];
    this.lastAction = label;
    this.state = next;
    this.persist();
    this.emit();
  }

  private load(): WorkspaceState {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return JSON.parse(saved) as WorkspaceState;
    } catch {
      // A corrupted local draft falls back to legacy data or the bundled demo data.
    }
    try {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy) {
        const parsed = JSON.parse(legacy) as WorkspaceState;
        parsed.components.forEach((component) => {
          if ((component.status as string) === 'review') component.status = 'published';
          component.activeRevision ??= null;
          component.snapshots ??= [];
        });
        return parsed;
      }
    } catch {
      // Fall through to the bundled demo data.
    }
    return createInitialState();
  }

  private persist(_notify = true) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  }

  private emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }
}
