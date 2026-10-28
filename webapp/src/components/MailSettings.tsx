import React from 'react';

import {BellIcon, EyeIcon, ImageIcon, MailOpenIcon, TrashIcon, UserIcon} from './icons';
import {Button, Toggle} from './ui';

import {api} from '../api';
import {bumpSignatureVersion, fitSize, isPortrait, mattermostPhoto, prepareSignatureImage, useSignatureImage} from '../signature';
import type {SignatureLayout} from '../signature';
import {setState, useStore} from '../state';
import type {Settings} from '../types';

// MailSettings edits the sender name and the preferences of a mailbox. It
// is used in the last step of the wizard and in the settings dialog.
export function MailSettings({settings, onChange, displayName, onDisplayName, email, botUsername, signatureImage = false}: {
    settings: Settings;
    onChange: (s: Settings) => void;
    displayName: string;
    onDisplayName: (v: string) => void;
    email: string;
    botUsername: string;

    // The picture is stored on the server for a connected mailbox only.
    signatureImage?: boolean;
}) {
    const set = (patch: Partial<Settings>) => onChange({...settings, ...patch});
    return (
        <div className='mml-settings'>
            <label className='mml-field'>
                <span className='mml-field__label'>{'Имя отправителя'}</span>
                <input
                    className='mml-input'
                    type='text'
                    maxLength={100}
                    placeholder='Иван Петров'
                    value={displayName}
                    onChange={(e) => onDisplayName(e.target.value)}
                />
                <span className='mml-field__hint'>
                    {'Получатели увидят: '}
                    <strong>{displayName.trim() ? `${displayName.trim()} <${email}>` : email}</strong>
                </span>
            </label>

            <Toggle
                icon={<BellIcon size={18}/>}
                label='Сообщать о новых письмах'
                description={`Бот @${botUsername} напишет, когда во «Входящие» придёт письмо, — с кнопками «Открыть» и «Прочитано».`}
                checked={settings.notify_new}
                onChange={(v) => set({notify_new: v})}
            />
            {settings.notify_new && (
                <Toggle
                    icon={<EyeIcon size={18}/>}
                    label='Показывать начало письма в уведомлении'
                    description='Первые строки текста. Выключите, если в чате с ботом не должно быть содержимого писем.'
                    checked={settings.notify_preview}
                    onChange={(v) => set({notify_preview: v})}
                />
            )}
            <Toggle
                icon={<MailOpenIcon size={18}/>}
                label='Отмечать прочитанным при открытии'
                description='Как в обычной почте. Если выключить, письмо останется непрочитанным, пока вы не отметите его сами.'
                checked={settings.mark_read_on_open}
                onChange={(v) => set({mark_read_on_open: v})}
            />
            <Toggle
                icon={<ImageIcon size={18}/>}
                label='Сразу показывать картинки из интернета'
                description='По умолчанию выключено: загрузка картинок сообщает отправителю, что письмо открыто. Показать их можно кнопкой в письме.'
                checked={settings.load_images}
                onChange={(v) => set({load_images: v})}
            />

            <label className='mml-field mml-field--spaced'>
                <span className='mml-field__label'>
                    {'Подпись'}
                    <span className='mml-optional'>{' (необязательно)'}</span>
                </span>
                <textarea
                    className='mml-input mml-textarea'
                    rows={3}
                    maxLength={2000}
                    placeholder={'С уважением,\nИван Петров'}
                    value={settings.signature}
                    onChange={(e) => set({signature: e.target.value})}
                />
                <span className='mml-field__hint'>{'Добавляется в новые письма и ответы. Её можно убрать перед отправкой.'}</span>
            </label>
            {signatureImage && (
                <SignatureImageEditor
                    text={settings.signature}
                    layout={settings.signature_layout || 'left'}
                    onLayout={(l) => set({signature_layout: l})}
                />
            )}
        </div>
    );
}

// SignatureImageEditor adds a photo or a logo to the signature: uploaded
// from the computer or taken from the Mattermost profile in one click.
function SignatureImageEditor({text, layout, onLayout}: {text: string; layout: SignatureLayout; onLayout: (l: SignatureLayout) => void}) {
    const me = useStore((s) => s.me);
    const img = useSignatureImage(me?.settings);
    const [busy, setBusy] = React.useState<'' | 'upload' | 'mm' | 'delete'>('');
    const [error, setError] = React.useState('');
    const fileInput = React.useRef<HTMLInputElement>(null);

    const save = async (kind: 'upload' | 'mm', get: () => Promise<Blob>) => {
        setBusy(kind);
        setError('');
        try {
            const dataUrl = await prepareSignatureImage(await get());
            const updated = await api.saveSignatureImage(dataUrl);
            bumpSignatureVersion();
            setState({me: updated});
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy('');
        }
    };
    const remove = async () => {
        setBusy('delete');
        setError('');
        try {
            setState({me: await api.deleteSignatureImage()});
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy('');
        }
    };

    const size = img && fitSize(img, layout);
    return (
        <div className='mml-field mml-sigimg'>
            <span className='mml-field__label'>{'Фото или логотип в подписи'}</span>
            <div className={`mml-sig-preview mml-sig-preview--${layout}`}>
                {img && size ? (
                    <img
                        src={img.url}
                        alt=''
                        style={{width: size.width, height: size.height, borderRadius: isPortrait(img, layout) ? '50%' : 6}}
                    />
                ) : (
                    <span className='mml-sig-preview__empty'>
                        <UserIcon size={24}/>
                    </span>
                )}
                <span className='mml-sig-preview__text'>{text.trim() || 'Текст подписи'}</span>
            </div>
            <div className='mml-row mml-row--wrap'>
                <Button
                    size='sm'
                    loading={busy === 'mm'}
                    disabled={Boolean(busy)}
                    onClick={() => save('mm', mattermostPhoto)}
                >
                    <UserIcon size={14}/>
                    {'Фото из Mattermost'}
                </Button>
                <Button
                    size='sm'
                    loading={busy === 'upload'}
                    disabled={Boolean(busy)}
                    onClick={() => fileInput.current?.click()}
                >
                    <ImageIcon size={14}/>
                    {img ? 'Заменить картинку' : 'Загрузить картинку'}
                </Button>
                {img && (
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
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) {
                            save('upload', async () => file);
                        }
                    }}
                />
            </div>
            {img && (
                <div
                    className='mml-segmented'
                    role='radiogroup'
                    aria-label='Расположение картинки'
                >
                    {([['left', 'Слева от текста'], ['above', 'Над текстом']] as Array<[SignatureLayout, string]>).map(([id, label]) => (
                        <button
                            key={id}
                            type='button'
                            role='radio'
                            aria-checked={layout === id}
                            className={layout === id ? 'mml-segmented__on' : ''}
                            onClick={() => onLayout(id)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            )}
            {error && <span className='mml-field__hint mml-field__hint--error'>{error}</span>}
            <span className='mml-field__hint'>{'Квадратное фото слева показывается кругом, как у контакта. Картинка уходит внутри письма — получателю не нужно ничего загружать.'}</span>
        </div>
    );
}
