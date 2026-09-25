import { createInitialState } from './data';
import type {
  ComponentSnapshot,
  ComponentSpec,
  ComponentStatus,
  RevisionContent,
  RevisionDraft,
  ValidationIssue,
  WorkspaceState
} from './types';

const STORAGE_KEY = 'sologsb-1028-workspace-v1';

const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const signature = (component: ComponentSpec) => `${component.properties.map((item) => `${item.name}:${item.required}`).join('|')}::${component.interactionSignature}`;

interface EditTarget {
  component: ComponentSpec;
  /** 非空表示编辑落在修订草稿内容上。 */
  draft: RevisionDraft | null;
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
      updatedAt: new Date().toISOString(),
      snapshots: [],
      activeRevision: null
    };
    this.commit('新建组件', (state) => {
      state.components.unshift(component);
      state.selectedId = id;
    });
  }

  /**
   * 编辑路由：进行中的修订草稿承接全部修改；
   * 已发布组件没有草稿时不可直接改，送审中的草稿被冻结。
   */
  private editTarget(state: WorkspaceState): EditTarget | null {
    const component = state.components.find((item) => item.id === state.selectedId);
    if (!component) return null;
    const draft = component.activeRevision;
    if (draft) return draft.status === 'editing' ? { component, draft } : null;
    if (component.status === 'published') return null;
    return { component, draft: null };
  }

  get canEditSelected(): boolean {
    return this.editTarget(this.state) !== null;
  }

  updateComponent(patch: Partial<RevisionContent>, markExamplesStale = false) {
    if (!this.editTarget(this.state)) return;
    this.commit('编辑组件', (state) => {
      const target = this.editTarget(state);
      if (!target) return;
      if (target.draft) {
        Object.assign(target.draft.content, patch);
        this.refreshReReview(target.draft);
      } else {
        Object.assign(target.component, patch);
        if (markExamplesStale) {
          target.component.examples.forEach((example) => {
            example.stale = true;
            example.staleReason = '组件交互或属性契约已修改，示例需要重新验证。';
          });
        }
      }
      target.component.updatedAt = new Date().toISOString();
    });
  }

  setStatus(status: ComponentStatus) {
    const component = this.selected;
    if (!component || component.activeRevision) return;
    this.commit('修改组件状态', (state) => {
      const target = state.components.find((item) => item.id === component.id);
      if (target && !target.activeRevision) {
        target.status = status;
        target.updatedAt = new Date().toISOString();
      }
    });
  }

  addProperty() {
    if (!this.editTarget(this.state)) return;
    this.commit('新增属性', (state) => {
      const target = this.editTarget(state);
      if (!target) return;
      (target.draft ? target.draft.content : target.component).properties.push({
        id: uid('property'),
        name: 'newProperty',
        type: 'string',
        required: false,
        defaultValue: '',
        description: '描述该属性对开发者和用户的影响。'
      });
      if (target.draft) this.refreshReReview(target.draft);
    });
  }

  updateProperty(propertyId: string, patch: Partial<ComponentSpec['properties'][number]>) {
    if (!this.editTarget(this.state)) return;
    this.commit('编辑属性', (state) => {
      const target = this.editTarget(state);
      if (!target) return;
      const properties = (target.draft ? target.draft.content : target.component).properties;
      const property = properties.find((item) => item.id === propertyId);
      if (property) Object.assign(property, patch);
      if (target.draft) this.refreshReReview(target.draft);
    });
  }

  removeProperty(propertyId: string) {
    if (!this.editTarget(this.state)) return;
    this.commit('删除属性', (state) => {
      const target = this.editTarget(state);
      if (!target) return;
      if (target.draft) {
        const content = target.draft.content;
        content.properties = content.properties.filter((item) => item.id !== propertyId);
        this.refreshReReview(target.draft);
        return;
      }
      const component = target.component;
      const property = component.properties.find((item) => item.id === propertyId);
      if (!property) return;
      component.properties = component.properties.filter((item) => item.id !== propertyId);
      component.examples.forEach((example) => {
        if (example.propertyIds.includes(propertyId) || example.code.includes(property.name)) {
          example.stale = true;
          example.staleReason = `属性 ${property.name} 已删除，示例代码或说明仍可能引用它。`;
        }
      });
    });
  }

  addExample() {
    if (!this.editTarget(this.state)) return;
    const exampleId = uid('example');
    this.commit('新增示例', (state) => {
      const target = this.editTarget(state);
      if (!target) return;
      const holder = target.draft ? target.draft.content : target.component;
      const tag = holder.name.toLowerCase().replaceAll(' ', '-');
      holder.examples.push({
        id: exampleId,
        title: '新示例',
        code: `<${tag}>示例</${tag}>`,
        propertyIds: [],
        stale: false,
        staleReason: '',
        createdFromRevision: target.component.revision
      });
    });
  }

  updateExample(exampleId: string, patch: Partial<ComponentSpec['examples'][number]>) {
    if (!this.editTarget(this.state)) return;
    this.commit('编辑示例', (state) => {
      const target = this.editTarget(state);
      if (!target) return;
      const examples = (target.draft ? target.draft.content : target.component).examples;
      const example = examples.find((item) => item.id === exampleId);
      if (example) Object.assign(example, patch);
    });
  }

  removeExample(exampleId: string) {
    if (!this.editTarget(this.state)) return;
    this.commit('删除示例', (state) => {
      const target = this.editTarget(state);
      if (!target) return;
      if (target.draft) {
        target.draft.content.examples = target.draft.content.examples.filter((item) => item.id !== exampleId);
      } else {
        target.component.examples = target.component.examples.filter((item) => item.id !== exampleId);
      }
    });
  }

  // ---- 修订草稿生命周期 ----

  /** 打开修订草稿：记下属性、交互与无障碍文本基线；同一组件只留一份。 */
  openRevision() {
    const component = this.selected;
    if (!component || component.status !== 'published' || component.activeRevision) return;
    this.commit('打开修订草稿', (state) => {
      const target = state.components.find((item) => item.id === component.id);
      if (!target || target.activeRevision) return;
      const content: RevisionContent = {
        name: target.name,
        category: target.category,
        purpose: target.purpose,
        usage: target.usage,
        properties: clone(target.properties),
        states: target.states,
        keyboardBehavior: target.keyboardBehavior,
        screenReader: target.screenReader,
        disabledScenarios: target.disabledScenarios,
        interactionSignature: target.interactionSignature,
        examples: clone(target.examples)
      };
      target.activeRevision = {
        id: uid('revision'),
        baseRevision: target.revision,
        openedAt: new Date().toISOString(),
        status: 'editing',
        baseline: clone(content),
        content,
        reviewNote: '',
        reviewLog: []
      };
    });
  }

  /** 送审：示例复核未完或存在错误级问题时拒绝。 */
  submitRevision(): { ok: boolean; reason?: string } {
    const component = this.selected;
    const draft = component?.activeRevision;
    if (!component || !draft || draft.status !== 'editing') {
      return { ok: false, reason: '当前没有可送审的修订草稿。' };
    }
    const pending = draft.content.examples.filter((example) => example.needsReReview).length;
    if (pending > 0) {
      return { ok: false, reason: `还有 ${pending} 个示例待复核，复核完成后才能送审。` };
    }
    const errors = this.validateComponent(component).filter((issue) => issue.level === 'error');
    if (errors.length > 0) {
      return { ok: false, reason: `存在 ${errors.length} 个错误级问题，请先修复再送审。` };
    }
    this.commit('送审修订', (state) => {
      const target = state.components.find((item) => item.id === component.id)?.activeRevision;
      if (!target || target.status !== 'editing') return;
      target.status = 'inReview';
      target.reviewNote = '';
      target.reviewLog.push({ at: new Date().toISOString(), action: 'submit', note: '' });
    });
    return { ok: true };
  }

  /** 批准：草稿一次性写入组件，并留下修订前后的快照。 */
  approveRevision() {
    const component = this.selected;
    const draft = component?.activeRevision;
    if (!component || !draft || draft.status !== 'inReview') return;
    this.commit('批准修订', (state) => {
      const target = state.components.find((item) => item.id === component.id);
      const active = target?.activeRevision;
      if (!target || !active || active.status !== 'inReview') return;
      const now = new Date().toISOString();
      const strip = (value: ComponentSpec): Omit<ComponentSpec, 'snapshots'> => {
        const { snapshots: _snapshots, ...rest } = clone(value);
        return rest;
      };
      const before: ComponentSnapshot = {
        revision: target.revision,
        savedAt: now,
        reason: `修订批准前（r${target.revision}）`,
        component: { ...strip(target), activeRevision: null }
      };
      const nextRevision = target.revision + 1;
      target.name = active.content.name;
      target.category = active.content.category;
      target.purpose = active.content.purpose;
      target.usage = active.content.usage;
      target.properties = clone(active.content.properties);
      target.states = active.content.states;
      target.keyboardBehavior = active.content.keyboardBehavior;
      target.screenReader = active.content.screenReader;
      target.disabledScenarios = active.content.disabledScenarios;
      target.interactionSignature = active.content.interactionSignature;
      target.examples = active.content.examples.map((example) => ({
        ...clone(example),
        stale: false,
        staleReason: '',
        needsReReview: false,
        createdFromRevision: nextRevision
      }));
      target.revision = nextRevision;
      target.updatedAt = now;
      target.activeRevision = null;
      const after: ComponentSnapshot = {
        revision: nextRevision,
        savedAt: now,
        reason: `修订批准后（r${nextRevision}）`,
        component: strip(target)
      };
      target.snapshots.unshift(before);
      target.snapshots.unshift(after);
      target.snapshots = target.snapshots.slice(0, 12);
    });
  }

  /** 驳回：必须填写意见，草稿退回编辑状态。 */
  rejectRevision(note: string): boolean {
    const component = this.selected;
    const draft = component?.activeRevision;
    if (!component || !draft || draft.status !== 'inReview' || !note.trim()) return false;
    this.commit('驳回修订', (state) => {
      const target = state.components.find((item) => item.id === component.id)?.activeRevision;
      if (!target || target.status !== 'inReview') return;
      target.status = 'editing';
      target.reviewNote = note.trim();
      target.reviewLog.push({ at: new Date().toISOString(), action: 'reject', note: note.trim() });
    });
    return true;
  }

  /** 放弃进行中的修订草稿。 */
  discardRevision() {
    const component = this.selected;
    if (!component || component.activeRevision?.status !== 'editing') return;
    this.commit('放弃修订草稿', (state) => {
      const target = state.components.find((item) => item.id === component.id);
      if (target?.activeRevision?.status === 'editing') target.activeRevision = null;
    });
  }

  /** 复核单个受影响的示例。 */
  markExampleReviewed(exampleId: string) {
    const draft = this.selected?.activeRevision;
    if (!draft || draft.status !== 'editing') return;
    this.commit('复核示例', (state) => {
      const target = state.components.find((item) => item.id === state.selectedId)?.activeRevision;
      const example = target?.content.examples.find((item) => item.id === exampleId);
      if (example) {
        example.needsReReview = false;
        example.staleReason = '';
      }
    });
  }

  /** 一键复核全部受影响示例。 */
  markAllExamplesReviewed() {
    const draft = this.selected?.activeRevision;
    if (!draft || draft.status !== 'editing') return;
    this.commit('复核全部示例', (state) => {
      const target = state.components.find((item) => item.id === state.selectedId)?.activeRevision;
      target?.content.examples.forEach((example) => {
        example.needsReReview = false;
        example.staleReason = '';
      });
    });
  }

  /**
   * 属性或交互变更后，把受影响的示例标记为待复核。
   * 已复核过的示例保持已复核；新受影响的才置位。
   */
  private refreshReReview(draft: RevisionDraft) {
    const { baseline, content } = draft;
    const interactionChanged =
      baseline.interactionSignature !== content.interactionSignature ||
      baseline.keyboardBehavior !== content.keyboardBehavior;
    const currentProps = new Map(content.properties.map((item) => [item.id, item]));
    const baselineProps = new Map(baseline.properties.map((item) => [item.id, item]));
    const removedBaselineProps = [...baselineProps.values()].filter((item) => !currentProps.has(item.id));
    for (const example of content.examples) {
      if (example.needsReReview) continue;
      let reason = '';
      if (interactionChanged) {
        reason = '交互行为已修改，示例需要复核。';
      } else if (example.propertyIds.some((id) => !currentProps.has(id))) {
        reason = '示例依赖的属性已被删除，需要复核。';
      } else if (
        example.propertyIds.some((id) => {
          const before = baselineProps.get(id);
          const after = currentProps.get(id);
          return Boolean(before && after && (before.name !== after.name || before.type !== after.type || before.required !== after.required));
        })
      ) {
        reason = '示例依赖的属性定义已修改，需要复核。';
      } else if (removedBaselineProps.some((item) => item.name && example.code.includes(item.name))) {
        reason = '示例代码可能引用了已删除的属性，需要复核。';
      }
      if (reason) {
        example.needsReReview = true;
        example.staleReason = reason;
      }
    }
  }

  createSnapshot(reason = '手动版本') {
    const selected = this.selected;
    if (!selected || selected.activeRevision) return;
    this.commit('创建版本快照', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const { snapshots: _ignored, ...component } = clone(target);
      const nextRevision = target.revision + 1;
      const snapshot: ComponentSnapshot = {
        revision: target.revision,
        savedAt: new Date().toISOString(),
        reason,
        component: { ...component, revision: target.revision }
      };
      target.snapshots.unshift(snapshot);
      target.snapshots = target.snapshots.slice(0, 12);
      target.revision = nextRevision;
      target.updatedAt = new Date().toISOString();
    });
  }

  migrateExamples() {
    const selected = this.selected;
    if (!selected || selected.activeRevision) return;
    this.commit('迁移示例到当前版本', (state) => {
      const target = state.components.find((item) => item.id === selected.id);
      if (!target) return;
      const currentSignature = signature(target);
      const activePropertyIds = new Set(target.properties.map((item) => item.id));
      target.examples.forEach((example) => {
        example.propertyIds = example.propertyIds.filter((id) => activePropertyIds.has(id));
        example.stale = false;
        example.staleReason = '';
        example.createdFromRevision = target.revision;
      });
      target.interactionSignature = currentSignature.split('::')[1] ?? target.interactionSignature;
      target.revision += 1;
      target.updatedAt = new Date().toISOString();
    });
  }

  validate(): ValidationIssue[] {
    return this.state.components.flatMap((component) => this.validateComponent(component));
  }

  private validateComponent(component: ComponentSpec): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const draft = component.activeRevision;
    const content = draft ? draft.content : component;
    const names = new Map<string, number>();
    content.properties.forEach((property) => names.set(property.name.trim(), (names.get(property.name.trim()) ?? 0) + 1));
    for (const [name, count] of names) {
      if (name && count > 1) {
        issues.push({ id: `${component.id}-duplicate-${name}`, level: 'error', componentId: component.id, target: content.name, message: `属性名称 ${name} 重复。`, field: 'properties' });
      }
    }
    content.examples.forEach((example) => {
      const missingReferences = example.propertyIds.filter((id) => !content.properties.some((property) => property.id === id));
      if (example.needsReReview) {
        issues.push({ id: `${component.id}-${example.id}-recheck`, level: 'warning', componentId: component.id, target: example.title, message: example.staleReason || '示例受属性或交互变更影响，等待复核。', field: 'examples' });
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
    if (draft) {
      if (draft.status === 'inReview') {
        issues.push({ id: `${component.id}-frozen`, level: 'info', componentId: component.id, target: content.name, message: '修订草稿已送审并冻结，批准或驳回后才能继续修改。', field: 'revision' });
      }
    } else {
      const contractChanged = component.examples.some((example) => example.createdFromRevision < component.revision);
      if (contractChanged && component.examples.length) {
        issues.push({ id: `${component.id}-contract`, level: 'info', componentId: component.id, target: component.name, message: '属性契约或交互签名发生变化，建议创建快照并迁移示例。', field: 'properties' });
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
      if (saved) {
        const parsed = JSON.parse(saved) as WorkspaceState;
        parsed.components.forEach((component) => {
          component.activeRevision ??= null;
          component.snapshots ??= [];
        });
        return parsed;
      }
    } catch {
      // A corrupted local draft falls back to the bundled demo data.
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
