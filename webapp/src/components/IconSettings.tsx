import React from 'react';

import {MailIcon, CheckIcon, ExternalIcon} from './icons';
import {ErrorCard} from './shared';
import {Button, PanelPage} from './ui';

import type {ApiError} from '../api';
import {api} from '../api';
import {closeWizard, getState, openInBrowser, openWizard, setState, useStore} from '../state';
import type {IconAction, IconInfo, Provider} from '../types';

export interface IconChoice {
    action: IconAction;
    webUrl: string;
}

export function choiceFrom(icon: IconInfo): IconChoice {
    return {action: icon.action, webUrl: icon.custom_web_url};
}

// saveIconChoice stores the choice and updates the cached state, so that the
// App Bar icon behaves accordingly on the very next click.
export async function saveIconChoice(choice: IconChoice) {
    const icon = await api.savePreferences(choice.action, choice.webUrl.trim());
    const me = getState().me;
    if (me) {
        setState({me: {...me, icon}});
    }
    return icon;
}

interface Preset {
    label: string;
    url: string;
}

function presets(providers: Provider[], defaultUrl: string): Preset[] {
    const list: Preset[] = [
        {label: 'Mail.ru', url: 'https://e.mail.ru/inbox/'},
        {label: 'Яндекс', url: 'https://mail.yandex.ru/'},
    ];
    const vk = providers.find((p) => p.id === 'vkworkspace');
    if (vk?.web_url && !list.some((p) => p.url === vk.web_url)) {
        list.push({label: 'VK WorkSpace', url: vk.web_url});
    }
    const custom = providers.find((p) => p.id === 'custom');
    if (custom?.web_url && !list.some((p) => p.url === custom.web_url)) {
        list.push({label: 'Корпоративный', url: custom.web_url});
    }
    if (defaultUrl && !list.some((p) => p.url === defaultUrl)) {
        list.unshift({label: 'Подключённый', url: defaultUrl});
    }
    return list;
}

// IconSettings lets every user decide what the mail icon on the right
// panel opens: the mail panel or the provider's own web mail.
export function IconSettings({value, onChange, icon, providers}: {
    value: IconChoice;
    onChange: (v: IconChoice) => void;
    icon: IconInfo;
    providers: Provider[];
}) {
    const effectiveUrl = value.webUrl.trim() || icon.default_web_url;
    const options: Array<{id: IconAction; title: string; desc: string}> = [
        {id: 'panel', title: 'Почта на панели', desc: 'Входящие, чтение, ответ и пересылка — прямо в Mattermost. Нужно один раз подключить почту.'},
        {id: 'browser', title: 'Почта в браузере', desc: 'Обычная веб-почта, как вы привыкли. Подключать ничего не нужно: иконка просто открывает страницу.'},
    ];

    return (
        <div className='mml-icon-settings'>
            <div
                className='mml-choice'
                role='radiogroup'
                aria-label='Что открывает иконка почты'
            >
                {options.map((o) => {
                    const off = o.id === 'browser' && !icon.browser_allowed;
                    return (
                        <button
                            key={o.id}
                            type='button'
                            role='radio'
                            aria-checked={value.action === o.id}
                            disabled={off}
                            className={`mml-choice__item ${value.action === o.id ? 'mml-choice__item--on' : ''} ${off ? 'mml-choice__item--off' : ''}`}
                            onClick={() => onChange({...value, action: o.id})}
                        >
                            <span className='mml-choice__radio'>{value.action === o.id && <CheckIcon size={12}/>}</span>
                            <span className='mml-choice__text'>
                                <span className='mml-choice__title'>{o.title}</span>
                                <span className='mml-choice__desc'>{off ? 'Выключено администратором: иконка открывает панель. Веб-почту можно открыть кнопкой внизу панели.' : o.desc}</span>
                            </span>
                        </button>
                    );
                })}
            </div>

            <div className='mml-field mml-icon-settings__url'>
                <span className='mml-field__label'>{'Адрес веб-почты'}</span>
                <div className='mml-chips'>
                    {presets(providers, icon.default_web_url).map((p) => {
                        const on = effectiveUrl === p.url;
                        return (
                            <button
                                key={p.url}
                                type='button'
                                className={`mml-chip ${on ? 'mml-chip--on' : ''}`}
                                aria-pressed={on}
                                onClick={() => onChange({...value, webUrl: p.url === icon.default_web_url ? '' : p.url})}
                            >
                                {p.label}
                            </button>
                        );
                    })}
                </div>
                <div className='mml-input-group'>
                    <input
                        className='mml-input'
                        type='url'
                        inputMode='url'
                        spellCheck={false}
                        placeholder={icon.default_web_url}
                        value={value.webUrl}
                        onChange={(e) => onChange({...value, webUrl: e.target.value})}
                    />
                    <button
                        type='button'
                        className='mml-icon-btn'
                        title='Открыть и проверить'
                        aria-label='Открыть и проверить'
                        onClick={() => openInBrowser(effectiveUrl)}
                    >
                        <ExternalIcon size={14}/>
                    </button>
                </div>
                <span className='mml-field__hint'>
                    {'Можно вставить любой адрес — например, веб-почту вашей компании. В приложении Mattermost для компьютера сайт откроется в браузере по умолчанию.'}
                </span>
            </div>
            {icon.forced_panel && (
                <div className='mml-hint'>{'Вы выбирали веб-почту, но администратор включил для вас панель. Если он снова разрешит, ваш выбор вернётся.'}</div>
            )}
            {value.action === 'browser' && icon.browser_allowed && (
                <div className='mml-hint'>{'Передумать легко: после открытия сайта на несколько секунд появится панель с кнопкой «Пользоваться почтой здесь». А ещё почту на панели всегда открывает команда /mail.'}</div>
            )}
        </div>
    );
}

// IconSettingsDialog is shown to users without a connected mailbox, who
// only want to choose what the icon does.
export default function IconSettingsDialog() {
    const me = useStore((s) => s.me);
    const config = useStore((s) => s.config);
    const [value, setValue] = React.useState<IconChoice | null>(me ? choiceFrom(me.icon) : null);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<ApiError | null>(null);

    if (!me || !config || !value) {
        return null;
    }

    const save = async () => {
        setSaving(true);
        setError(null);
        try {
            await saveIconChoice(value);
            closeWizard();
        } catch (e) {
            setError(e as ApiError);
        } finally {
            setSaving(false);
        }
    };

    return (
        <PanelPage
            title='Что открывает иконка почты'
            onClose={closeWizard}
            width={560}
            footer={(
                <div className='mml-wizard__footer'>
                    <div className='mml-wizard__help'>
                        {!me.connected && (
                            <button
                                type='button'
                                className='mml-link'
                                onClick={() => openWizard('connect')}
                            >
                                <MailIcon size={14}/>
                                {'Подключить почту'}
                            </button>
                        )}
                    </div>
                    <div className='mml-wizard__buttons'>
                        <Button
                            variant='tertiary'
                            onClick={closeWizard}
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
            <IconSettings
                value={value}
                onChange={setValue}
                icon={me.icon}
                providers={config.providers}
            />
            {error && <ErrorCard error={error}/>}
        </PanelPage>
    );
}
