import React from 'react';

import {ImageIcon, TrashIcon, UserIcon} from './icons';
import {SignatureCard} from './MailSettings';
import {Button, PanelPage} from './ui';

import type {ApiError} from '../api';
import {api} from '../api';
import {
    SIGNATURE_BLUE, bumpSignatureVersion, escapeHTML, mattermostPhoto, prepareSignatureImage, sanitizeSignatureHTML,
    signatureTemplate,
} from '../signature';
import type {ImageKind, SignatureLayout} from '../signature';
import {closeSignature, setState, showToast, useStore} from '../state';
import type {Settings} from '../types';

// Colours of the palette: greys, the navy and blue of corporate mail, and a
// few accents. Any other colour can be picked with the last swatch.
const PALETTE = [
    '#1f1f1f', '#5a5a5a', '#8c8c8c', SIGNATURE_BLUE, '#0077ff', '#1e88e5',
    '#00897b', '#2e7d32', '#c62828', '#d81b60', '#ef6c00', '#6a1b9a',
];

const SIZES: Array<{label: string; value: string}> = [
    {label: 'Мелкий', value: '2'},
    {label: 'Обычный', value: '3'},
    {label: 'Крупный', value: '5'},
];

// linkTarget turns what the user typed into an address: e-mail, phone or site.
export function linkTarget(raw: string): string {
    const s = raw.trim();
    if (!s) {
        return '';
    }
    if ((/^(https?:\/\/|mailto:|tel:)/i).test(s)) {
        return s;
    }
    if ((/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(s)) {
        return `mailto:${s}`;
    }
    if ((/^\+?[\d\s()-]{6,}$/).test(s)) {
        return `tel:${s.replace(/[^\d+]/g, '')}`;
    }
    return `https://${s}`;
}

function initialHTML(s?: Settings) {
    if (!s) {
        return '';
    }
    return s.signature_html ? sanitizeSignatureHTML(s.signature_html) : escapeHTML(s.signature || '').replace(/\n/g, '<br>');
}

export default function SignatureEditor() {
    const me = useStore((s) => s.me);
    const config = useStore((s) => s.config);
    const settings = me?.settings;
    const editorRef = React.useRef<HTMLDivElement>(null);
    const range = React.useRef<Range | null>(null);
    const [html, setHtml] = React.useState(() => initialHTML(settings));
    const [layout, setLayout] = React.useState<SignatureLayout>(settings?.signature_layout || 'left');
    const [logoHeight, setLogoHeight] = React.useState(settings?.signature_logo_height || 48);
    const [menu, setMenu] = React.useState<'' | 'color' | 'size'>('');
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');

    React.useEffect(() => {
        if (editorRef.current) {
            editorRef.current.innerHTML = html;
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    if (!me || !config || !settings) {
        return null;
    }
    const required = config.require_signature;

    const sync = () => setHtml(editorRef.current?.innerHTML || '');
    const saveSelection = () => {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) {
            range.current = sel.getRangeAt(0).cloneRange();
        }
    };
    const restoreSelection = () => {
        editorRef.current?.focus();
        const sel = window.getSelection();
        if (sel && range.current) {
            sel.removeAllRanges();
            sel.addRange(range.current);
        }
    };

    // Formatting goes through the browser's editing commands: they keep the
    // undo history (Ctrl+Z) and handle selections across tags.
    const exec = (command: string, value?: string) => {
        restoreSelection();
        document.execCommand('styleWithCSS', false, 'true');
        document.execCommand(command, false, value);
        saveSelection();
        sync();
    };

    const addLink = () => {
        saveSelection();
        // eslint-disable-next-line no-alert
        const raw = window.prompt('Адрес ссылки: сайт, почта или телефон', 'https://');
        const href = linkTarget(raw || '');
        if (!href || href === 'https://https://') {
            return;
        }
        if (range.current && !range.current.collapsed) {
            exec('createLink', href);
        } else {
            exec('insertHTML', `<a href="${escapeHTML(href)}">${escapeHTML((raw || '').trim())}</a>&nbsp;`);
        }
    };

    const useTemplate = () => {
        // eslint-disable-next-line no-alert
        if (editorRef.current?.textContent?.trim() && !window.confirm('Заменить подпись шаблоном? Текущий текст пропадёт.')) {
            return;
        }
        const tpl = signatureTemplate({name: me.display_name || config.display_name, position: config.position, email: me.email});
        if (editorRef.current) {
            editorRef.current.innerHTML = tpl;
        }
        sync();
    };

    const save = async () => {
        const clean = sanitizeSignatureHTML(editorRef.current?.innerHTML || '');
        const text = (editorRef.current?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
        if (required && !text) {
            setError('Подпись обязательна — так решил администратор.');
            editorRef.current?.scrollIntoView({block: 'center'});
            editorRef.current?.focus();
            return;
        }
        setSaving(true);
        setError('');
        try {
            const updated = await api.saveSettings(me.display_name || '', {
                ...settings,
                signature: text,
                signature_html: text ? clean : '',
                signature_layout: layout,
                signature_logo_height: logoHeight,
            });
            setState({me: updated});
            showToast('Подпись сохранена');
            closeSignature();
        } catch (e) {
            const err = e as ApiError;
            setError(err.details || err.message);
            setSaving(false);
        }
    };

    const toolButton = (label: string, title: string, onClick: () => void, extra = '') => (
        <button
            type='button'
            className={`mml-sig-tool ${extra}`}
            title={title}
            aria-label={title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
        >
            {label}
        </button>
    );

    return (
        <PanelPage
            title='Подпись'
            onClose={closeSignature}
            footer={(
                <div className='mml-wizard__footer'>
                    <div className='mml-wizard__help'/>
                    <div className='mml-wizard__buttons'>
                        <Button
                            variant='tertiary'
                            onClick={closeSignature}
                        >
                            {'Отмена'}
                        </Button>
                        <Button
                            variant='primary'
                            loading={saving}
                            onClick={save}
                        >
                            {'Сохранить'}
                        </Button>
                    </div>
                </div>
            )}
        >
            <div className='mml-field'>
                <span className='mml-field__label'>
                    {'Текст подписи'}
                    {required && <span className='mml-required'>{' *'}</span>}
                </span>
                <div
                    className='mml-sig-toolbar'
                    role='toolbar'
                    aria-label='Оформление подписи'
                >
                    {toolButton('Ж', 'Жирный (Ctrl+B)', () => exec('bold'), 'mml-sig-tool--bold')}
                    {toolButton('К', 'Курсив (Ctrl+I)', () => exec('italic'), 'mml-sig-tool--italic')}
                    {toolButton('Ч', 'Подчёркнутый (Ctrl+U)', () => exec('underline'), 'mml-sig-tool--underline')}
                    <span className='mml-menu-anchor'>
                        <button
                            type='button'
                            className='mml-sig-tool mml-sig-tool--color'
                            title='Цвет текста'
                            aria-label='Цвет текста'
                            aria-expanded={menu === 'color'}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                saveSelection();
                            }}
                            onClick={() => setMenu(menu === 'color' ? '' : 'color')}
                        >
                            {'А'}
                            <span style={{background: SIGNATURE_BLUE}}/>
                        </button>
                        {menu === 'color' && (
                            <div
                                className='mml-sig-palette'
                                role='menu'
                            >
                                {PALETTE.map((c) => (
                                    <button
                                        key={c}
                                        type='button'
                                        role='menuitem'
                                        className='mml-sig-swatch'
                                        style={{background: c}}
                                        title={c}
                                        aria-label={`Цвет ${c}`}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => {
                                            exec('foreColor', c);
                                            setMenu('');
                                        }}
                                    />
                                ))}
                                <label
                                    className='mml-sig-swatch mml-sig-swatch--custom'
                                    title='Свой цвет'
                                >
                                    <input
                                        type='color'
                                        aria-label='Свой цвет'
                                        defaultValue={SIGNATURE_BLUE}
                                        onChange={(e) => exec('foreColor', e.target.value)}
                                    />
                                </label>
                                <button
                                    type='button'
                                    className='mml-link mml-small mml-sig-palette__reset'
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => {
                                        exec('foreColor', '#333333');
                                        setMenu('');
                                    }}
                                >
                                    {'Обычный цвет'}
                                </button>
                            </div>
                        )}
                    </span>
                    <span className='mml-menu-anchor'>
                        <button
                            type='button'
                            className='mml-sig-tool'
                            title='Размер текста'
                            aria-label='Размер текста'
                            aria-expanded={menu === 'size'}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                saveSelection();
                            }}
                            onClick={() => setMenu(menu === 'size' ? '' : 'size')}
                        >
                            {'Aa'}
                        </button>
                        {menu === 'size' && (
                            <ul
                                className='mml-menu mml-menu--left'
                                role='menu'
                                onMouseLeave={() => setMenu('')}
                            >
                                {SIZES.map((sz) => (
                                    <li key={sz.value}>
                                        <button
                                            type='button'
                                            role='menuitem'
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={() => {
                                                exec('fontSize', sz.value);
                                                setMenu('');
                                            }}
                                        >
                                            {sz.label}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </span>
                    {toolButton('🔗', 'Ссылка: сайт, почта или телефон', addLink)}
                    {toolButton('⌫', 'Убрать оформление', () => {
                        exec('removeFormat');
                        exec('unlink');
                    })}
                    <span className='mml-mb-header__spacer'/>
                    <button
                        type='button'
                        className='mml-link mml-small'
                        onClick={useTemplate}
                    >
                        {'Шаблон'}
                    </button>
                </div>
                <div
                    ref={editorRef}
                    className={`mml-input mml-sig-editor ${required && !html.replace(/<[^>]*>|&nbsp;/g, '').trim() ? 'mml-input--error' : ''}`}
                    contentEditable={true}
                    suppressContentEditableWarning={true}
                    role='textbox'
                    aria-multiline='true'
                    aria-label='Текст подписи'
                    data-placeholder={'С уважением,\nИван Петров'}
                    onInput={sync}
                    onKeyUp={saveSelection}
                    onMouseUp={saveSelection}
                    onBlur={saveSelection}
                    onFocus={() => setMenu('')}
                    onPaste={(e) => {
                        // A signature copied from Outlook or web mail keeps
                        // its colours and links, but nothing else.
                        e.preventDefault();
                        const pasted = e.clipboardData.getData('text/html');
                        const clean = pasted ? sanitizeSignatureHTML(pasted) : escapeHTML(e.clipboardData.getData('text/plain')).replace(/\r?\n/g, '<br>');
                        document.execCommand('insertHTML', false, clean);
                        sync();
                    }}
                />
                {error ? (
                    <span
                        className='mml-field__hint mml-field__hint--error'
                        role='alert'
                    >
                        {error}
                    </span>
                ) : <span className='mml-field__hint'>{'Выделите текст и выберите цвет или начертание. «Шаблон» — готовая подпись как в VK WorkSpace.'}</span>}
            </div>

            <ImageSlot
                kind='logo'
                title='Логотип компании'
                hint='Ставится под подписью. PNG с прозрачным фоном смотрится лучше всего.'
                enabled={Boolean(settings.signature_logo)}
            >
                {settings.signature_logo && (
                    <label className='mml-sig-range'>
                        <span>{'Высота'}</span>
                        <input
                            type='range'
                            min={24}
                            max={120}
                            step={4}
                            value={logoHeight}
                            onChange={(e) => setLogoHeight(Number(e.target.value))}
                        />
                        <span className='mml-muted'>{`${logoHeight} px`}</span>
                    </label>
                )}
            </ImageSlot>

            <ImageSlot
                kind='photo'
                title='Фото'
                hint='Квадратное фото слева показывается кругом, как у контакта.'
                enabled={Boolean(settings.signature_image)}
            >
                {settings.signature_image && (
                    <div
                        className='mml-segmented'
                        role='radiogroup'
                        aria-label='Где фото'
                    >
                        {([['left', 'Слева от текста'], ['above', 'Над текстом']] as Array<[SignatureLayout, string]>).map(([id, label]) => (
                            <button
                                key={id}
                                type='button'
                                role='radio'
                                aria-checked={layout === id}
                                className={layout === id ? 'mml-segmented__on' : ''}
                                onClick={() => setLayout(id)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                )}
            </ImageSlot>

            <div className='mml-field'>
                <span className='mml-field__label'>{'Так увидят получатели'}</span>
                <SignatureCard
                    settings={{
                        ...settings,
                        signature: editorRef.current?.innerText || settings.signature,
                        signature_html: html,
                        signature_layout: layout,
                        signature_logo_height: logoHeight,
                    }}
                />
            </div>
        </PanelPage>
    );
}

// ImageSlot uploads, replaces or removes the photo or the logo. Pictures
// are stored right away; the rest of the signature on "Сохранить".
function ImageSlot({kind, title, hint, enabled, children}: {kind: ImageKind; title: string; hint: string; enabled: boolean; children?: React.ReactNode}) {
    const [busy, setBusy] = React.useState<'' | 'upload' | 'mm' | 'delete'>('');
    const [error, setError] = React.useState('');
    const fileInput = React.useRef<HTMLInputElement>(null);

    const upload = async (how: 'upload' | 'mm', get: () => Promise<Blob>) => {
        setBusy(how);
        setError('');
        try {
            const dataUrl = await prepareSignatureImage(await get(), kind);
            const updated = await api.saveSignatureImage(dataUrl, kind);
            bumpSignatureVersion();
            setState({me: updated});
        } catch (e) {
            setError((e as ApiError).details || (e as Error).message);
        } finally {
            setBusy('');
        }
    };
    const remove = async () => {
        setBusy('delete');
        setError('');
        try {
            setState({me: await api.deleteSignatureImage(kind)});
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy('');
        }
    };

    return (
        <div className='mml-field mml-sigimg'>
            <span className='mml-field__label'>{title}</span>
            <div className='mml-row mml-row--wrap'>
                {kind === 'photo' && (
                    <Button
                        size='sm'
                        loading={busy === 'mm'}
                        disabled={Boolean(busy)}
                        onClick={() => upload('mm', mattermostPhoto)}
                    >
                        <UserIcon size={14}/>
                        {'Фото из Mattermost'}
                    </Button>
                )}
                <Button
                    size='sm'
                    loading={busy === 'upload'}
                    disabled={Boolean(busy)}
                    onClick={() => fileInput.current?.click()}
                >
                    <ImageIcon size={14}/>
                    {enabled ? 'Заменить' : 'Загрузить'}
                </Button>
                {enabled && (
                    <Button
                        size='sm'
                        variant='tertiary'
                        loading={busy === 'delete'}
                        disabled={Boolean(busy)}
                        onClick={remove}
                    >
                        <TrashIcon size={14}/>
                        {'Убрать'}
                    </Button>
                )}
                <input
                    ref={fileInput}
                    type='file'
                    accept='image/png,image/jpeg,image/gif'
                    style={{display: 'none'}}
                    aria-label={`${title}: файл`}
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) {
                            upload('upload', async () => file);
                        }
                    }}
                />
            </div>
            {children}
            {error && <span className='mml-field__hint mml-field__hint--error'>{error}</span>}
            <span className='mml-field__hint'>{hint}</span>
        </div>
    );
}
