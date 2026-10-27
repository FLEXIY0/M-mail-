import React from 'react';

import {IconSettings, choiceFrom, saveIconChoice} from './IconSettings';
import type {IconChoice} from './IconSettings';
import {MailSettings} from './MailSettings';
import {ErrorCard} from './shared';
import {Button, Callout, Modal} from './ui';

import type {ApiError} from '../api';
import {api} from '../api';
import {closeWizard, getState, openWizard, setState, useStore} from '../state';
import type {Settings} from '../types';

export default function SettingsDialog() {
    const me = useStore((s) => s.me);
    const config = useStore((s) => s.config);

    const [settings, setSettings] = React.useState<Settings | null>(me?.settings ? {...me.settings} : null);
    const [displayName, setDisplayName] = React.useState(me?.display_name || '');
    const [iconChoice, setIconChoice] = React.useState<IconChoice | null>(me ? choiceFrom(me.icon) : null);
    const [saving, setSaving] = React.useState(false);
    const [saveError, setSaveError] = React.useState<ApiError | null>(null);
    const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
    const [disconnecting, setDisconnecting] = React.useState(false);
    const dangerRef = React.useRef<HTMLElement>(null);

    React.useEffect(() => {
        if (confirmDisconnect) {
            dangerRef.current?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
        }
    }, [confirmDisconnect]);

    if (!me || !config || !settings || !iconChoice) {
        return null;
    }
    const provider = config.providers.find((p) => p.id === me.provider);

    const save = async () => {
        setSaving(true);
        setSaveError(null);
        try {
            const iconChanged = iconChoice.action !== choiceFrom(me.icon).action || iconChoice.webUrl.trim() !== me.icon.custom_web_url;
            const updated = await api.saveSettings(displayName, settings);
            setState({me: updated});
            if (iconChanged) {
                await saveIconChoice(iconChoice);
            }
            closeWizard();
        } catch (e) {
            setSaveError(e as ApiError);
        } finally {
            setSaving(false);
        }
    };

    const disconnect = async () => {
        setDisconnecting(true);
        try {
            const updated = await api.disconnect();
            setState({me: updated, revision: getState().revision + 1});
            closeWizard();
        } catch (e) {
            setSaveError(e as ApiError);
            setDisconnecting(false);
        }
    };

    return (
        <Modal
            title='Настройки почты'
            onClose={closeWizard}
            footer={(
                <div className='mml-wizard__footer'>
                    <div className='mml-wizard__help'/>
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
            <section className='mml-section'>
                <h4 className='mml-section__title'>{'Ящик'}</h4>
                <div className='mml-account'>
                    <div>
                        <div className='mml-account__name'>{me.email}</div>
                        <div className='mml-muted'>
                            {me.provider_name}
                            {me.imap && ` · ${me.imap.host}`}
                        </div>
                    </div>
                    <Button
                        size='sm'
                        onClick={() => openWizard('reconnect')}
                    >
                        {'Переподключить'}
                    </Button>
                </div>
                {me.sync?.auth_failed && (
                    <Callout
                        kind='warning'
                        title='Почта не принимает сохранённый пароль'
                    >
                        {'Создайте новый пароль приложения и нажмите «Переподключить».'}
                    </Callout>
                )}
            </section>

            <section className='mml-section'>
                <h4 className='mml-section__title'>{'Письма и уведомления'}</h4>
                <MailSettings
                    settings={settings}
                    onChange={setSettings}
                    displayName={displayName}
                    onDisplayName={setDisplayName}
                    email={me.email || me.username || ''}
                    botUsername={config.bot_username}
                />
            </section>

            <section className='mml-section'>
                <h4 className='mml-section__title'>{'Иконка почты открывает'}</h4>
                <IconSettings
                    value={iconChoice}
                    onChange={setIconChoice}
                    icon={me.icon}
                    providers={config.providers}
                />
            </section>

            {saveError && (
                <ErrorCard
                    error={saveError}
                    provider={provider}
                />
            )}

            <section
                className='mml-section mml-section--danger'
                ref={dangerRef}
            >
                {confirmDisconnect ? (
                    <Callout
                        kind='error'
                        title='Отключить почту?'
                        action={(
                            <div className='mml-row'>
                                <Button
                                    size='sm'
                                    variant='tertiary'
                                    onClick={() => setConfirmDisconnect(false)}
                                >
                                    {'Нет'}
                                </Button>
                                <Button
                                    size='sm'
                                    variant='danger'
                                    loading={disconnecting}
                                    onClick={disconnect}
                                >
                                    {'Отключить'}
                                </Button>
                            </div>
                        )}
                    >
                        {'Сохранённый пароль приложения будет удалён с сервера Mattermost. Письма останутся в вашей почте. Сам пароль приложения можно отозвать в настройках безопасности почты.'}
                    </Callout>
                ) : (
                    <button
                        type='button'
                        className='mml-link mml-link--danger'
                        onClick={() => setConfirmDisconnect(true)}
                    >
                        {'Отключить почту'}
                    </button>
                )}
            </section>
        </Modal>
    );
}
