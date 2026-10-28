import React from 'react';

import {CopyIcon, FolderIcon, InboxIcon, MoveIcon, PenIcon, PlusIcon, Spinner, TrashIcon} from './icons';
import {folderTitle} from './Panel';
import {ErrorCard} from './shared';
import {Button, Callout, PanelPage, Toggle} from './ui';

import type {ApiError} from '../api';
import {api} from '../api';
import {closeRule, mailChanged, openRule, popRoute, showToast} from '../state';
import type {SortRuleDraft} from '../state';
import type {Folder, SortRule} from '../types';

// Folders a rule can sort into: anything but Inbox.
function targets(folders: Folder[]) {
    return folders.filter((f) => !f.no_select && f.role !== 'inbox');
}

function folderLabel(folders: Folder[], name: string) {
    const f = folders.find((x) => x.name === name);
    return f ? folderTitle(f) : name;
}

export function ruleSummary(rule: {from: string; keep_in_inbox: boolean}, folder: string) {
    const who = rule.from.startsWith('@') ? `всех с адресов ${rule.from}` : rule.from;
    return rule.keep_in_inbox ? `Письма от ${who} — копия в «${folder}», остаются во «Входящих»` : `Письма от ${who} — сразу в «${folder}»`;
}

function useFoldersAndRules() {
    const [folders, setFolders] = React.useState<Folder[] | null>(null);
    const [rules, setRules] = React.useState<SortRule[] | null>(null);
    const [error, setError] = React.useState<ApiError | null>(null);
    React.useEffect(() => {
        Promise.all([api.folders(), api.rules()]).
            then(([f, r]) => {
                setFolders(f.folders);
                setRules(r.rules);
            }).
            catch((e: ApiError) => setError(e));
    }, []);
    return {folders, rules, setRules, error};
}

// RulesPage lists the sorting rules of the mailbox.
export function RulesPage() {
    const {folders, rules, setRules, error} = useFoldersAndRules();
    const [deleting, setDeleting] = React.useState('');

    const remove = async (rule: SortRule) => {
        setDeleting(rule.id);
        try {
            const res = await api.deleteRule(rule.id);
            setRules(res.rules);
            showToast('Правило удалено');
        } catch (e) {
            showToast((e as ApiError).message, {kind: 'error'});
        } finally {
            setDeleting('');
        }
    };

    return (
        <PanelPage
            title='Правила сортировки'
            onClose={popRoute}
            actions={(
                <button
                    type='button'
                    className='mml-icon-btn mml-icon-btn--lg mml-icon-btn--accent-plain'
                    title='Новое правило'
                    aria-label='Новое правило'
                    onClick={() => openRule()}
                >
                    <PlusIcon size={22}/>
                </button>
            )}
        >
            <p className='mml-muted mml-rules__lead'>
                {'Новые письма от выбранных отправителей сами попадают в нужную папку. Если включить «Оставлять во „Входящих“», письмо будет и там, и в папке.'}
            </p>
            {error && (
                <ErrorCard
                    error={error}
                    compact={true}
                />
            )}
            {!error && (!folders || !rules) && <div className='mml-center'><Spinner size={24}/></div>}
            {folders && rules && rules.length === 0 && (
                <div className='mml-empty'>
                    <MoveIcon size={36}/>
                    <div className='mml-empty__title'>{'Правил пока нет'}</div>
                    <div className='mml-muted mml-small'>{'Перетащите письмо в папку и нажмите «Всегда сюда» — или создайте правило здесь.'}</div>
                    <Button
                        variant='primary'
                        onClick={() => openRule()}
                    >
                        {'Создать правило'}
                    </Button>
                </div>
            )}
            {folders && rules && rules.length > 0 && (
                <ul className='mml-rules'>
                    {rules.map((rule) => (
                        <li
                            key={rule.id}
                            className='mml-rule'
                        >
                            <button
                                type='button'
                                className='mml-rule__main'
                                onClick={() => openRule({id: rule.id, from: rule.from, folder: rule.folder, keepInInbox: rule.keep_in_inbox})}
                            >
                                <span className='mml-rule__from mml-ellipsis'>{rule.from}</span>
                                <span className='mml-rule__to'>
                                    <FolderIcon size={14}/>
                                    <span className='mml-ellipsis'>{folderLabel(folders, rule.folder)}</span>
                                    {rule.keep_in_inbox && (
                                        <span
                                            className='mml-rule__badge'
                                            title='Письмо остаётся и во «Входящих»'
                                        >
                                            <CopyIcon size={12}/>
                                            {'+ Входящие'}
                                        </span>
                                    )}
                                </span>
                                {rule.applied > 0 && <span className='mml-muted mml-small'>{`Разложено писем: ${rule.applied}`}</span>}
                                {rule.last_error && <span className='mml-rule__error'>{`Не сработало: ${rule.last_error}`}</span>}
                            </button>
                            <button
                                type='button'
                                className='mml-icon-btn'
                                title='Изменить'
                                aria-label={`Изменить правило для ${rule.from}`}
                                onClick={() => openRule({id: rule.id, from: rule.from, folder: rule.folder, keepInInbox: rule.keep_in_inbox})}
                            >
                                <PenIcon size={16}/>
                            </button>
                            <button
                                type='button'
                                className='mml-icon-btn mml-icon-btn--danger'
                                title='Удалить правило'
                                aria-label={`Удалить правило для ${rule.from}`}
                                disabled={deleting === rule.id}
                                onClick={() => remove(rule)}
                            >
                                {deleting === rule.id ? <Spinner size={14}/> : <TrashIcon size={16}/>}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <p className='mml-muted mml-small mml-rules__note'>
                {'Правила выполняет Mattermost, когда проверяет почту (и сразу, когда вы открываете «Входящие»). Поэтому в почтовом приложении на телефоне новое письмо может мелькнуть во «Входящих» на минуту-другую.'}
            </p>
        </PanelPage>
    );
}

// RuleEditor creates or changes one rule.
export function RuleEditor({draft}: {draft: SortRuleDraft}) {
    const {folders, rules, error: loadError} = useFoldersAndRules();
    const editing = Boolean(draft.id);
    const [from, setFrom] = React.useState(draft.from || '');
    const [folder, setFolder] = React.useState(draft.folder || '');
    const [keep, setKeep] = React.useState(Boolean(draft.keepInInbox));
    const [applyExisting, setApplyExisting] = React.useState(!editing);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');

    // The rule for this sender may exist already: editing it then.
    const existing = rules?.find((r) => r.id === draft.id || (!draft.id && r.from === from.trim().toLowerCase()));
    React.useEffect(() => {
        if (existing && !editing && !draft.folder) {
            setFolder(existing.folder);
            setKeep(existing.keep_in_inbox);
        }
    }, [existing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const list = folders ? targets(folders) : [];
    const domain = from.includes('@') ? from.trim().split('@').pop() : '';

    const save = async () => {
        setSaving(true);
        setError('');
        try {
            const res = await api.saveRule({id: draft.id || existing?.id, from, folder, keep_in_inbox: keep, apply_existing: applyExisting});
            const title = folders ? folderLabel(folders, res.rule.folder) : res.rule.folder;
            let text = editing || existing ? 'Правило изменено.' : 'Правило создано.';
            if (res.sorted > 0) {
                text += ` ${res.moved > 0 ? 'Перенесено' : 'Скопировано'} в «${title}» писем: ${res.sorted}`;
            }
            showToast(text);
            mailChanged();
            closeRule();
        } catch (e) {
            const err = e as ApiError;
            setError(err.details || err.message);
            setSaving(false);
        }
    };

    return (
        <PanelPage
            title={editing || existing ? 'Правило' : 'Новое правило'}
            onClose={closeRule}
            footer={(
                <div className='mml-wizard__footer'>
                    <div className='mml-wizard__help'/>
                    <div className='mml-wizard__buttons'>
                        <Button
                            variant='tertiary'
                            onClick={closeRule}
                        >
                            {'Отмена'}
                        </Button>
                        <Button
                            variant='primary'
                            loading={saving}
                            disabled={!from.trim() || !folder}
                            onClick={save}
                        >
                            {'Сохранить'}
                        </Button>
                    </div>
                </div>
            )}
        >
            {loadError && (
                <ErrorCard
                    error={loadError}
                    compact={true}
                />
            )}
            <label className='mml-field'>
                <span className='mml-field__label'>{'Письма от'}</span>
                <input
                    className='mml-input'
                    value={from}
                    placeholder='anna@example.ru или @example.ru'
                    maxLength={320}
                    onChange={(e) => setFrom(e.target.value)}
                />
                <span className='mml-field__hint'>
                    {'Адрес отправителя или домен целиком'}
                    {domain && !from.trim().startsWith('@') && (
                        <>
                            {' — '}
                            <button
                                type='button'
                                className='mml-link'
                                onClick={() => setFrom(`@${domain}`)}
                            >
                                {`все письма с @${domain}`}
                            </button>
                        </>
                    )}
                </span>
            </label>

            <label className='mml-field'>
                <span className='mml-field__label'>{'Класть в папку'}</span>
                {folders ? (
                    <select
                        className='mml-input'
                        value={folder}
                        onChange={(e) => setFolder(e.target.value)}
                    >
                        <option value=''>{'Выберите папку'}</option>
                        {list.map((f) => (
                            <option
                                key={f.name}
                                value={f.name}
                            >
                                {`${'   '.repeat(f.depth)}${folderTitle(f)}`}
                            </option>
                        ))}
                    </select>
                ) : <Spinner/>}
            </label>

            <Toggle
                icon={<InboxIcon size={18}/>}
                label='Оставлять во «Входящих»'
                description={keep ? 'Письмо будет в двух местах: во «Входящих» (с обычным уведомлением) и копия в папке.' : 'Выключено: письмо сразу уходит в папку, во «Входящих» его не будет и бот о нём не напишет.'}
                checked={keep}
                onChange={setKeep}
            />
            <Toggle
                icon={<MoveIcon size={18}/>}
                label='Разложить письма, которые уже во «Входящих»'
                description={keep ? 'Их копии появятся в папке. Если правило уже применялось, копии могут повториться.' : 'Уже полученные письма от этого отправителя переедут в папку.'}
                checked={applyExisting}
                onChange={setApplyExisting}
            />

            {from.trim() && folder && folders && (
                <Callout kind='info'>
                    {ruleSummary({from: from.trim().toLowerCase(), keep_in_inbox: keep}, folderLabel(folders, folder))}
                </Callout>
            )}
            {error && <div className='mml-field__hint mml-field__hint--error'>{error}</div>}
        </PanelPage>
    );
}
