import React from 'react';

import {BellIcon, EyeIcon, ImageIcon, MailOpenIcon, PenIcon} from './icons';
import {Button, Toggle} from './ui';

import {escapeHTML, fitSize, isPortrait, logoSize, sanitizeSignatureHTML, useSignatureImage} from '../signature';
import {openSignature, useStore} from '../state';
import type {Settings} from '../types';

// MailSettings edits the sender name and the preferences of a mailbox. It
// is used in the last step of the wizard and in the settings dialog.
export function MailSettings({settings, onChange, displayName, onDisplayName, email, botUsername, signatureImage = false, required = false}: {
    settings: Settings;
    onChange: (s: Settings) => void;
    displayName: string;
    onDisplayName: (v: string) => void;
    email: string;
    botUsername: string;

    // A connected mailbox gets the full signature editor (formatting and
    // pictures are stored on the server); the wizard has a plain field.
    signatureImage?: boolean;
    required?: boolean;
}) {
    const set = (patch: Partial<Settings>) => onChange({...settings, ...patch});

    // The signature is saved by its own editor: show what is stored.
    const stored = useStore((st) => st.me?.settings);
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

            {signatureImage ? (
                <div className='mml-field mml-field--spaced'>
                    <span className='mml-field__label'>
                        {'Подпись'}
                        {required && <span className='mml-required'>{' *'}</span>}
                    </span>
                    <SignatureCard settings={stored || settings}/>
                    <div className='mml-row'>
                        <Button
                            size='sm'
                            variant='primary'
                            onClick={openSignature}
                        >
                            <PenIcon size={14}/>
                            {'Оформить подпись'}
                        </Button>
                    </div>
                    <span className='mml-field__hint'>{'Цвет, жирный шрифт, ссылки, фото и логотип компании.'}</span>
                </div>
            ) : (
                <label className='mml-field mml-field--spaced'>
                    <span className='mml-field__label'>
                        {'Подпись'}
                        {required ? <span className='mml-required'>{' *'}</span> : <span className='mml-optional'>{' (необязательно)'}</span>}
                    </span>
                    <textarea
                        className={`mml-input mml-textarea ${required && !settings.signature.trim() ? 'mml-input--error' : ''}`}
                        rows={4}
                        maxLength={2000}
                        placeholder={'С уважением,\nИван Петров'}
                        value={settings.signature}
                        required={required}
                        onChange={(e) => set({signature: e.target.value, signature_html: ''})}
                    />
                    <span className={`mml-field__hint ${required && !settings.signature.trim() ? 'mml-field__hint--error' : ''}`}>
                        {required && !settings.signature.trim() ? 'Подпись обязательна — так решил администратор.' : 'Цвет, логотип и фото можно добавить после подключения: Настройки почты → «Оформить подпись».'}
                    </span>
                </label>
            )}
        </div>
    );
}

// SignatureCard shows the signature as recipients will see it.
export function SignatureCard({settings}: {settings: Settings}) {
    const photo = useSignatureImage(settings, 'photo');
    const logo = useSignatureImage(settings, 'logo');
    const layout = settings.signature_layout || 'left';
    const html = settings.signature_html ? sanitizeSignatureHTML(settings.signature_html) : escapeHTML(settings.signature).replace(/\n/g, '<br>');
    const photoSize = photo && fitSize(photo, layout);
    const logoBox = logo && logoSize(logo, settings.signature_logo_height);
    if (!html && !photo && !logo) {
        return <div className='mml-sig-card mml-sig-card--empty'>{'Подписи пока нет'}</div>;
    }
    return (
        <div className='mml-sig-card'>
            <div className={`mml-sig-preview mml-sig-preview--${layout}`}>
                {photo && photoSize && (
                    <img
                        src={photo.url}
                        alt=''
                        style={{width: photoSize.width, height: photoSize.height, borderRadius: isPortrait(photo, layout) ? '50%' : 6}}
                    />
                )}
                <div
                    className='mml-sig-html'

                    // Sanitized above: text formatting only, no scripts.
                    dangerouslySetInnerHTML={{__html: html}}
                />
            </div>
            {logo && logoBox && (
                <img
                    className='mml-sig-card__logo'
                    src={logo.url}
                    alt=''
                    style={{width: logoBox.width, height: logoBox.height}}
                />
            )}
        </div>
    );
}
