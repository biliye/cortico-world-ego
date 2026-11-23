import type { WebUiPanel } from 'cortico/web/shared/client-panel.ts';
import { sourceLabel, type SearchPanelState, type SearchSource, type WebSearchProvider } from '../search-settings.ts';

export const searchPanel: WebUiPanel = {
  async mount(ctx) {
    const { ui } = ctx;
    const zh = ctx.language.startsWith('zh');
    const t = (cn: string, en: string) => zh ? cn : en;
    const card = ui.sheet({
      title: t('搜索来源', 'Search sources'),
      desc: t('拖动或用箭头排序。查梗按列表顺序查询，普通网页搜索默认使用 Tavily 和 DeepSeek。', 'Drag or use the arrows to reorder. Meme lookups follow this list. Web search uses Tavily and DeepSeek by default.'),
    });
    const list = ui.h('div');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', t('搜索来源优先级', 'Search source priority'));
    const message = ui.msgline(t('正在读取搜索设置…', 'Loading search settings…'));
    message.setAttribute('role', 'status');
    card.body.append(list, message);
    ctx.root.append(card.el);
    let state: SearchPanelState;
    try { state = await ctx.invoke<SearchPanelState>('settings'); }
    catch { message.textContent = t('读取搜索设置失败。', 'Could not load search settings.'); return; }
    if (ctx.signal.aborted) return;
    message.textContent = '';

    let dirty = false;
    let busy = false;
    let dragging: string | undefined;
    let editing: string | undefined;
    const keys: HTMLInputElement[] = [];
    const lockWhileSaving: Array<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement> = [];
    ctx.guardLeave(() => dirty || keys.some(key => key.value)
      ? t('搜索设置或密钥尚未保存。', 'There are unsaved search settings or keys.') : null);
    ctx.own({ dispose: () => { for (const key of keys) key.value = ''; } });

    function move(id: string, to: number, focus?: 'up' | 'down'): void {
      const sources = state.settings.sources;
      const from = sources.findIndex(source => source.id === id);
      if (busy || from < 0 || to < 0 || to >= sources.length || from === to) return;
      const [source] = sources.splice(from, 1);
      sources.splice(to, 0, source);
      dirty = true;
      render();
      if (focus) {
        const row = list.querySelector<HTMLElement>(`[data-source="${id}"]`);
        const button = row?.querySelector<HTMLButtonElement>(`[data-move="${focus}"]:enabled`)
          ?? row?.querySelector<HTMLButtonElement>('[data-move]:enabled');
        button?.focus();
      }
    }

    function wikiEditor(source: Extract<SearchSource, { kind: 'mediawiki' }>): HTMLElement {
      const editor = ui.h('div');
      const name = ui.input({ value: source.name, disabled: busy, onInput: value => { source.name = value; dirty = true; } });
      name.maxLength = 60;
      const endpoint = ui.input({ value: source.endpoint, placeholder: 'https://wiki.site.org/api.php', disabled: busy, onInput: value => { source.endpoint = value; dirty = true; } });
      endpoint.maxLength = 512;
      const remove = ui.button(t('移除此来源', 'Remove source'), { size: 'sm', variant: 'danger', onClick: () => {
        state.settings.sources = state.settings.sources.filter(item => item.id !== source.id);
        editing = undefined;
        dirty = true;
        render();
        add.focus();
      } });
      remove.disabled = busy;
      editor.append(ui.field(t('名称', 'Name'), name), ui.field(t('MediaWiki API 地址', 'MediaWiki API address'), endpoint), remove);
      return editor;
    }

    function render(): void {
      if (ctx.signal.aborted) return;
      list.replaceChildren();
      state.settings.sources.forEach((source, index) => {
        const name = sourceLabel(source) || 'MediaWiki';
        const entry = ui.h('div');
        entry.setAttribute('role', 'listitem');
        entry.dataset.source = source.id;
        const row = ui.rowbar();
        row.draggable = !busy;
        row.style.paddingBlock = '8px';
        row.style.flexWrap = 'wrap';
        row.addEventListener('dragstart', event => {
          if (busy) { event.preventDefault(); return; }
          dragging = source.id;
          event.dataTransfer?.setData('text/plain', source.id);
        });
        row.addEventListener('dragover', event => { if (dragging && !busy) event.preventDefault(); });
        row.addEventListener('drop', event => {
          if (!dragging || busy) return;
          event.preventDefault();
          const id = dragging;
          dragging = undefined;
          move(id, index);
        });
        row.addEventListener('dragend', () => { dragging = undefined; });
        const enabled = ui.checkbox(`${index + 1}. ${name}`, {
          checked: source.enabled, disabled: busy, onChange: checked => { source.enabled = checked; dirty = true; },
        });
        const badge = source.kind === 'mediawiki'
          ? ui.pill(t('MediaWiki · 无需密钥', 'MediaWiki · no key'))
          : state.configured[source.kind]
            ? ui.pill(t('密钥已配置', 'Key configured'), 'on')
            : ui.pill(t('未配置，查询时跳过', 'Skipped until configured'), 'off');
        row.append(enabled.el, badge, ui.h('span', 'grow'));
        if (source.kind === 'mediawiki') {
          const edit = ui.button(editing === source.id ? t('收起', 'Close') : t('编辑', 'Edit'), { size: 'sm', onClick: () => {
            editing = editing === source.id ? undefined : source.id;
            render();
            const entry = list.querySelector<HTMLElement>(`[data-source="${source.id}"]`);
            entry?.querySelector<HTMLElement>(editing ? 'input[type=text]' : '[data-edit]')?.focus();
          } });
          edit.dataset.edit = '';
          edit.setAttribute('aria-expanded', String(editing === source.id));
          edit.setAttribute('aria-label', `${editing === source.id ? t('收起', 'Close') : t('编辑', 'Edit')} ${name}`);
          edit.disabled = busy;
          row.append(edit);
        }
        for (const direction of ['up', 'down'] as const) {
          const up = direction === 'up';
          const target = index + (up ? -1 : 1);
          const arrow = ui.button(up ? '↑' : '↓', { size: 'sm', onClick: () => move(source.id, target, direction) });
          arrow.dataset.move = direction;
          arrow.setAttribute('aria-label', `${up ? t('上移', 'Move up') : t('下移', 'Move down')} ${name}`);
          arrow.disabled = busy || target < 0 || target >= state.settings.sources.length;
          row.append(arrow);
        }
        entry.append(row);
        if (source.kind === 'mediawiki' && editing === source.id) entry.append(wikiEditor(source));
        list.append(entry);
      });
      add.disabled = busy || state.settings.sources.length >= 10;
    }

    async function run(task: () => Promise<void>, feedback = message): Promise<void> {
      if (busy) return;
      busy = true;
      feedback.textContent = '';
      const restore = ui.disable(...lockWhileSaving);
      render();
      try { await task(); }
      catch (error) {
        if (!ctx.signal.aborted) feedback.textContent = t('保存失败。', 'Save failed. ') + (error instanceof Error ? error.message : '');
      } finally {
        restore.dispose();
        busy = false;
        render();
      }
    }

    const add = ui.button(t('添加 MediaWiki 来源', 'Add MediaWiki source'), { onClick: () => {
      const id = `wiki-${Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const firstWebSource = state.settings.sources.findIndex(source => source.kind !== 'mediawiki');
      state.settings.sources.splice(firstWebSource, 0, { id, kind: 'mediawiki', name: '', endpoint: '', enabled: true });
      editing = id;
      dirty = true;
      render();
      list.querySelector<HTMLInputElement>(`[data-source="${id}"] input[type=text]`)?.focus();
    } });
    const domains = ui.textarea({
      rows: 2, value: state.settings.preferredDomains.join('\n'),
      onInput: () => { dirty = true; },
    });
    const save = ui.button(t('保存搜索设置', 'Save search settings'), { variant: 'primary', onClick: () => void run(async () => {
      const preferredDomains = domains.value.split(/[\s,，]+/).filter(Boolean);
      const settings = await ctx.invoke<SearchPanelState>('save', [{ ...state.settings, preferredDomains }]);
      if (ctx.signal.aborted) return;
      state = settings;
      dirty = false;
      domains.value = state.settings.preferredDomains.join('\n');
      message.textContent = t('已保存，下次搜索生效。', 'Saved. Changes apply to the next search.');
    }) });
    lockWhileSaving.push(domains, save);
    const actions = ui.actions();
    actions.append(add, save);
    card.body.insertBefore(ui.field(t('查梗时 Tavily 优先搜索的域名（每行一个）', 'Preferred Tavily domains for meme searches (one per line)'), domains), message);
    card.body.insertBefore(actions, message);

    const keyCard = ui.sheet({ title: t('搜索 API 密钥', 'Search API keys') });
    for (const [provider, name] of [['tavily', 'Tavily'], ['deepseek', 'DeepSeek']] as const satisfies ReadonlyArray<readonly [WebSearchProvider, string]>) {
      const input = ui.input({ type: 'password' });
      input.autocomplete = 'new-password';
      input.spellcheck = false;
      input.maxLength = 512;
      const feedback = ui.msgline();
      feedback.setAttribute('role', 'status');
      const button = ui.button(t('保存密钥', 'Save key'), { onClick: () => {
        const key = input.value.trim();
        if (!key) { feedback.textContent = t('请输入 API 密钥。', 'Enter an API key.'); return; }
        void run(async () => {
          const next = await ctx.invoke<SearchPanelState>('save-key', [provider, key]);
          input.value = '';
          if (ctx.signal.aborted) return;
          state.configured = next.configured;
          feedback.textContent = t('密钥已保存。', 'Key saved.');
        }, feedback);
      } });
      keys.push(input);
      lockWhileSaving.push(input, button);
      keyCard.body.append(ui.field(`${name} API key`, input), button, feedback);
    }
    ctx.root.append(keyCard.el);
    render();
  },
};
