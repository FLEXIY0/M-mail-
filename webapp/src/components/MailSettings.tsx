import React from 'react';

import {BellIcon, EyeIcon, ImageIcon, MailOpenIcon} from './icons';
import {Toggle} from './ui';

import type {Settings} from '../types';

// MailSettings edits the sender name and the preferences of a mailbox. It
// is used in the last step of the wizard and in the settings dialog.
export function MailSettings({settings, onChange, displayName, onDisplayName, email, botUsername}: {
    settings: Settings;
    onChange: (s: Settings) => void;
    displayName: string;
    onDisplayName: (v: string) => void;
    email: string;
    botUsername: string;
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
                <span className='mml-field__hint'>{'Добавляется в новые письма и ответы. Её можно стереть перед отправкой.'}</span>
            </label>
        </div>
    );
}
