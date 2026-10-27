import React from 'react';

import {
    BellIcon, CheckIcon, ExternalIcon, EyeIcon, EyeOffIcon, InboxIcon,
    MailIcon, SendIcon, ShieldIcon, Spinner,
} from './icons';
import IconSettingsDialog from './IconSettings';
import {MailSettings} from './MailSettings';
import SettingsDialog from './SettingsDialog';
import {ErrorCard, HelpText} from './shared';
import {Button, Callout, Details, LinkButton, Modal} from './ui';

import type {ApiError} from '../api';
import {api} from '../api';
import {pluralMessages} from '../format';
import {guideFor, guides} from '../guides';
import {closeWizard, getState, openPanel, setState, useStore} from '../state';
import type {CheckResult, Endpoint, Me, PluginConfig, Provider, Security, Settings, WizardMode} from '../types';

type Step = 'welcome' | 'provider' | 'password' | 'credentials' | 'settings' | 'done';

const STEPS: Array<{id: Step; label: string}> = [
    {id: 'provider', label: 'Сервис'},
    {id: 'password', label: 'Пароль'},
    {id: 'credentials', label: 'Вход'},
    {id: 'settings', label: 'Настройки'},
];

type CheckPhase = 'idle' | 'checking' | 'ok' | 'error';

// WizardRoot is registered as a root component and shows the wizard or the
// settings dialog when requested from the panel, a slash command or a
// websocket event.
export default function WizardRoot() {
    const mode = useStore((s) => s.wizard);
    const config = useStore((s) => s.config);
    const me = useStore((s) => s.me);
    const loadError = useStore((s) => s.loadError);

    if (!mode) {
        return null;
    }
    if (!config || !me) {
        return (
            <Modal
                title='Почта'
                onClose={closeWizard}
                width={480}
            >
                {loadError ? (
                    <Callout
                        kind='error'
                        title='Не удалось загрузить настройки плагина'
                    >
                        {loadError}
                    </Callout>
                ) : (
                    <div className='mml-center'><Spinner size={24}/></div>
                )}
            </Modal>
        );
    }
    if (mode === 'icon' || (mode === 'settings' && !me.connected)) {
        return <IconSettingsDialog/>;
    }
    if (mode === 'settings') {
        return <SettingsDialog/>;
    }
    return (
        <Wizard
            mode={mode}
            config={config}
            me={me}
        />
    );
}

function emptyEndpoint(port: number): Endpoint {
    return {host: '', port, security: 'tls'};
}

function Wizard({mode, config, me}: {mode: WizardMode; config: PluginConfig; me: Me}) {
    // Decided once: after a successful connect "me.connected" flips to true,
    // but the dialog must keep saying "connect", not "reconnect".
    const [reconnect] = React.useState(() => me.connected && (mode === 'reconnect' || mode === 'connect'));
    const initialProvider = config.providers.find((p) => p.id === (reconnect ? me.provider : config.default_provider)) || config.providers[0];

    const [step, setStep] = React.useState<Step>(reconnect ? 'password' : 'welcome');
    const [provider, setProvider] = React.useState<Provider | undefined>(initialProvider);
    const [username, setUsername] = React.useState(reconnect && me.username ? me.username : config.email);
    const [password, setPassword] = React.useState('');
    const [imap, setImap] = React.useState<Endpoint>(() => me.imap || (initialProvider?.server_editable && initialProvider.imap.host ? initialProvider.imap : emptyEndpoint(993)));
    const [smtp, setSmtp] = React.useState<Endpoint>(() => me.smtp || (initialProvider?.server_editable && initialProvider.smtp.host ? initialProvider.smtp : emptyEndpoint(465)));
    const [phase, setPhase] = React.useState<CheckPhase>('idle');
    const [error, setError] = React.useState<ApiError | null>(null);
    const [checked, setChecked] = React.useState<CheckResult | null>(null);
    const [settings, setSettings] = React.useState<Settings>(() => ({...(me.settings || config.default_settings)}));
    const [displayName, setDisplayName] = React.useState(me.display_name || config.display_name);
    const [saving, setSaving] = React.useState(false);
    const [saveError, setSaveError] = React.useState<ApiError | null>(null);

    // Only ask before closing when the user would actually lose something.
    const dirty = step !== 'done' && (password !== '' || phase === 'ok');
    const close = () => {
        // eslint-disable-next-line no-alert
        if (dirty && !window.confirm('Прервать подключение почты? Введённые данные не сохранятся.')) {
            return;
        }
        closeWizard();
    };

    const chooseProvider = (p: Provider) => {
        setProvider(p);
        setError(null);
        setPhase('idle');
        if (p.server_editable) {
            setImap(p.imap.host ? p.imap : emptyEndpoint(993));
            setSmtp(p.smtp.host ? p.smtp : emptyEndpoint(465));
        }
    };

    const creds = () => ({
        provider: provider?.id || '',
        imap: provider?.server_editable ? imap : undefined,
        smtp: provider?.server_editable ? smtp : undefined,
        username,
        password,
    });

    const check = async () => {
        if (!provider) {
            return;
        }
        setPhase('checking');
        setError(null);
        try {
            const res = await api.check(creds());
            setChecked(res);
            setPhase('ok');
            window.setTimeout(() => setStep('settings'), 1100);
        } catch (e) {
            setError(e as ApiError);
            setPhase('error');
        }
    };

    const finish = async () => {
        if (!provider) {
            return;
        }
        setSaving(true);
        setSaveError(null);
        try {
            const updated = await api.connect(creds(), username.includes('@') ? username : config.email, displayName, settings);
            setState({me: updated, revision: getState().revision + 1});
            setPassword('');
            setStep('done');
        } catch (e) {
            setSaveError(e as ApiError);
        } finally {
            setSaving(false);
        }
    };

    const stepIndex = STEPS.findIndex((s) => s.id === step);
    const serverMissing = Boolean(provider?.server_editable && !imap.host.trim());
    const canCheck = Boolean(provider && username.trim() && password.trim() && !serverMissing && phase !== 'checking');

    let body: React.ReactNode;
    let footer: React.ReactNode;
    const back = (to: Step) => (
        <Button
            variant='tertiary'
            onClick={() => setStep(to)}
        >
            {'Назад'}
        </Button>
    );

    switch (step) {
    case 'welcome':
        body = <WelcomeStep botUsername={config.bot_username}/>;
        footer = (
            <Button
                variant='primary'
                size='lg'
                onClick={() => setStep(config.providers.length === 1 ? 'password' : 'provider')}
            >
                {'Начать'}
            </Button>
        );
        break;

    case 'provider':
        body = (
            <ProviderStep
                providers={config.providers}
                selected={provider}
                detected={config.default_provider}
                email={config.email}
                onSelect={chooseProvider}
            />
        );
        footer = (
            <>
                {!reconnect && back('welcome')}
                <Button
                    variant='primary'
                    disabled={!provider}
                    onClick={() => setStep('password')}
                >
                    {'Дальше'}
                </Button>
            </>
        );
        break;

    case 'password':
        body = (
            <PasswordStep
                provider={provider}
                reconnect={reconnect}
                authFailed={Boolean(me.sync?.auth_failed)}
            />
        );
        footer = (
            <>
                {config.providers.length > 1 && back('provider')}
                <Button
                    variant='primary'
                    onClick={() => setStep('credentials')}
                >
                    {provider?.id === 'custom' ? 'Дальше' : 'Пароль создан, дальше'}
                </Button>
            </>
        );
        break;

    case 'credentials':
        body = (
            <CredentialsStep
                provider={provider}
                username={username}
                password={password}
                imap={imap}
                smtp={smtp}
                phase={phase}
                error={error}
                checked={checked}
                onUsername={(v) => {
                    setUsername(v);
                    setPhase('idle');
                }}
                onPassword={(v) => {
                    setPassword(v);
                    setPhase('idle');
                }}
                onImap={(v) => {
                    setImap(v);
                    setPhase('idle');
                }}
                onSmtp={(v) => {
                    setSmtp(v);
                    setPhase('idle');
                }}
                onSubmit={() => canCheck && check()}
            />
        );
        footer = (
            <>
                {back('password')}
                <Button
                    variant='primary'
                    disabled={!canCheck}
                    loading={phase === 'checking'}
                    onClick={check}
                >
                    {phase === 'error' ? 'Проверить ещё раз' : 'Проверить подключение'}
                </Button>
            </>
        );
        break;

    case 'settings':
        body = (
            <>
                <p className='mml-lead'>{'Последний шаг: как вас подписывать и о чём сообщать. Всё можно поменять позже в настройках.'}</p>
                <MailSettings
                    settings={settings}
                    onChange={setSettings}
                    displayName={displayName}
                    onDisplayName={setDisplayName}
                    email={username.includes('@') ? username : config.email}
                    botUsername={config.bot_username}
                />
                {saveError && (
                    <ErrorCard
                        error={saveError}
                        provider={provider}
                    />
                )}
            </>
        );
        footer = (
            <>
                {back('credentials')}
                <Button
                    variant='primary'
                    loading={saving}
                    disabled={!password}
                    onClick={finish}
                >
                    {reconnect ? 'Сохранить' : 'Подключить почту'}
                </Button>
            </>
        );
        break;

    case 'done':
        body = (
            <DoneStep
                settings={settings}
                botUsername={config.bot_username}
                checked={checked}
            />
        );
        footer = (
            <Button
                variant='primary'
                size='lg'
                onClick={() => {
                    closeWizard();
                    openPanel();
                }}
            >
                {'Открыть почту'}
            </Button>
        );
        break;
    }

    return (
        <Modal
            title={reconnect ? 'Переподключение почты' : 'Подключение почты'}
            onClose={step === 'done' ? closeWizard : close}
            footer={(
                <div className='mml-wizard__footer'>
                    <div className='mml-wizard__help'><HelpText text={config.help_text}/></div>
                    <div className='mml-wizard__buttons'>{footer}</div>
                </div>
            )}
        >
            {stepIndex >= 0 && (
                <Stepper
                    current={stepIndex}
                    onJump={(i) => {
                        // Only already visited steps can be revisited.
                        if (i < stepIndex) {
                            setStep(STEPS[i].id);
                        }
                    }}
                />
            )}
            <div
                className='mml-wizard__body'
                key={step}
            >
                {body}
            </div>
        </Modal>
    );
}

function Stepper({current, onJump}: {current: number; onJump: (i: number) => void}) {
    return (
        <ol className='mml-stepper'>
            {STEPS.map((s, i) => {
                let state = 'todo';
                if (i < current) {
                    state = 'done';
                } else if (i === current) {
                    state = 'current';
                }
                return (
                    <li
                        key={s.id}
                        className={`mml-stepper__item mml-stepper__item--${state}`}
                        aria-current={i === current ? 'step' : undefined}
                    >
                        <button
                            type='button'
                            disabled={i >= current}
                            onClick={() => onJump(i)}
                        >
                            <span className='mml-stepper__dot'>{i < current ? <CheckIcon size={12}/> : i + 1}</span>
                            <span className='mml-stepper__label'>{s.label}</span>
                        </button>
                    </li>
                );
            })}
        </ol>
    );
}

function WelcomeStep({botUsername}: {botUsername: string}) {
    return (
        <div className='mml-welcome'>
            <div className='mml-welcome__icon'><MailIcon size={40}/></div>
            <h2>{'Ваша почта — прямо в Mattermost'}</h2>
            <p className='mml-lead'>{'Подключим VK WorkSpace, Mail.ru, Яндекс или любую почту с IMAP. Это займёт около двух минут.'}</p>
            <ul className='mml-benefits'>
                <li>
                    <InboxIcon size={18}/>
                    <span><strong>{'Входящие на панели справа'}</strong>{' — читайте письма рядом с чатами'}</span>
                </li>
                <li>
                    <SendIcon size={18}/>
                    <span><strong>{'Ответ и пересылка'}</strong>{' — с вложениями и адресами коллег из Mattermost'}</span>
                </li>
                <li>
                    <BellIcon size={18}/>
                    <span><strong>{'Уведомления'}</strong>{` о новых письмах от бота @${botUsername}`}</span>
                </li>
                <li>
                    <MailIcon size={18}/>
                    <span><strong>{'Сообщение — письмом'}</strong>{' — любое сообщение из чата можно отправить по почте'}</span>
                </li>
            </ul>
            <Callout kind='info'>
                <span className='mml-inline-icon'><ShieldIcon size={16}/></span>
                {'Понадобится доступ к почте, чтобы создать отдельный пароль для приложения. Основной пароль от почты вводить не нужно. Письма не копируются в Mattermost — плагин читает их с почтового сервера.'}
            </Callout>
        </div>
    );
}

function ProviderStep({providers, selected, detected, email, onSelect}: {
    providers: Provider[];
    selected?: Provider;
    detected: string;
    email: string;
    onSelect: (p: Provider) => void;
}) {
    const domain = email.split('@')[1];
    const autoDetected = providers.find((p) => p.id === detected && p.domains?.includes(domain || ''));
    return (
        <>
            <h3 className='mml-step-title'>{'Где ваша почта?'}</h3>
            {autoDetected && (
                <p className='mml-lead'>{`Судя по адресу ${email}, это ${autoDetected.name}. Если нет — выберите другой вариант.`}</p>
            )}
            <div
                className='mml-providers'
                role='radiogroup'
            >
                {providers.map((p) => {
                    const g = guides[p.id] || guides.custom;
                    const active = selected?.id === p.id;
                    return (
                        <button
                            key={p.id}
                            type='button'
                            role='radio'
                            aria-checked={active}
                            className={`mml-provider ${active ? 'mml-provider--active' : ''}`}
                            onClick={() => onSelect(p)}
                        >
                            <span
                                className='mml-provider__badge'
                                style={{background: g.badgeColor}}
                            >
                                {g.badge}
                            </span>
                            <span className='mml-provider__text'>
                                <span className='mml-provider__name'>
                                    {p.name}
                                    {p.recommended && <span className='mml-tag mml-provider__tag'>{'Рекомендуем'}</span>}
                                </span>
                                <span className='mml-provider__desc'>{g.subtitle}</span>
                            </span>
                            <span className='mml-provider__check'>{active && <CheckIcon size={16}/>}</span>
                        </button>
                    );
                })}
            </div>
        </>
    );
}

function PasswordStep({provider, reconnect, authFailed}: {provider?: Provider; reconnect: boolean; authFailed: boolean}) {
    const guide = guideFor(provider);
    return (
        <>
            <h3 className='mml-step-title'>{guide.passwordTitle}</h3>
            {reconnect && authFailed && (
                <Callout
                    kind='warning'
                    title='Сохранённый пароль перестал подходить'
                >
                    {'Скорее всего, пароль приложения удалили или он истёк. Создайте новый — это минута.'}
                </Callout>
            )}
            {guide.before && <p className='mml-lead'>{guide.before}</p>}
            {provider?.app_password_url && guide.passwordButton && (
                <div className='mml-cta'>
                    <LinkButton
                        href={provider.app_password_url}
                        variant='secondary'
                        size='lg'
                    >
                        {guide.passwordButton}
                        <ExternalIcon size={14}/>
                    </LinkButton>
                    <span className='mml-hint'>{'Откроется в новой вкладке. Создайте пароль по шагам ниже и вернитесь сюда.'}</span>
                </div>
            )}
            <ol className='mml-steps'>
                {guide.steps.map((s, i) => (
                    <li key={i}>
                        <span className='mml-steps__num'>{i + 1}</span>
                        <div className='mml-steps__text'>{s}</div>
                    </li>
                ))}
            </ol>
            {(guide.trouble || provider?.help_url) && (
                <Details summary='Не получается?'>
                    <ul>
                        {guide.trouble?.map((t, i) => <li key={i}>{t}</li>)}
                        {provider?.help_url && (
                            <li>
                                <a
                                    href={provider.help_url}
                                    target='_blank'
                                    rel='noopener noreferrer'
                                >
                                    {`Справка: ${provider.name}`}
                                </a>
                            </li>
                        )}
                    </ul>
                </Details>
            )}
        </>
    );
}

const SECURITY_OPTIONS: Array<{value: Security; label: string}> = [
    {value: 'tls', label: 'SSL/TLS'},
    {value: 'starttls', label: 'STARTTLS'},
    {value: 'none', label: 'Без шифрования'},
];

function securityFor(port: number, current: Security): Security {
    if (port === 993 || port === 465) {
        return 'tls';
    }
    if (port === 143 || port === 587 || port === 25) {
        return 'starttls';
    }
    return current;
}

function ServerField({label, value, onChange, disabled, defaultPort}: {
    label: string;
    value: Endpoint;
    onChange: (v: Endpoint) => void;
    disabled: boolean;
    defaultPort: number;
}) {
    return (
        <div className='mml-field'>
            <span className='mml-field__label'>{label}</span>
            <div className='mml-server-row'>
                <input
                    className='mml-input mml-server-row__host'
                    type='text'
                    inputMode='url'
                    autoComplete='off'
                    spellCheck={false}
                    placeholder={defaultPort === 993 ? 'imap.company.ru' : 'smtp.company.ru'}
                    value={value.host}
                    disabled={disabled}
                    aria-label={`${label}: адрес`}
                    onChange={(e) => onChange({...value, host: e.target.value.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')})}
                />
                <input
                    className='mml-input mml-server-row__port'
                    type='number'
                    min={1}
                    max={65535}
                    value={value.port || ''}
                    placeholder={String(defaultPort)}
                    disabled={disabled}
                    aria-label={`${label}: порт`}
                    onChange={(e) => {
                        const port = parseInt(e.target.value, 10) || 0;
                        onChange({...value, port, security: securityFor(port, value.security)});
                    }}
                />
                <select
                    className='mml-select mml-server-row__security'
                    value={value.security}
                    disabled={disabled}
                    aria-label={`${label}: шифрование`}
                    onChange={(e) => onChange({...value, security: e.target.value as Security})}
                >
                    {SECURITY_OPTIONS.map((o) => (
                        <option
                            key={o.value}
                            value={o.value}
                        >
                            {o.label}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}

function CredentialsStep(props: {
    provider?: Provider;
    username: string;
    password: string;
    imap: Endpoint;
    smtp: Endpoint;
    phase: CheckPhase;
    error: ApiError | null;
    checked: CheckResult | null;
    onUsername: (v: string) => void;
    onPassword: (v: string) => void;
    onImap: (v: Endpoint) => void;
    onSmtp: (v: Endpoint) => void;
    onSubmit: () => void;
}) {
    const {provider, phase, error} = props;
    const guide = guideFor(provider);
    const [showPassword, setShowPassword] = React.useState(false);
    const [spacesRemoved, setSpacesRemoved] = React.useState(false);
    const passwordRef = React.useRef<HTMLInputElement>(null);

    React.useEffect(() => {
        passwordRef.current?.focus();
    }, []);

    const onPasswordChange = (value: string) => {
        const cleaned = value.replace(/\s+/g, '');
        setSpacesRemoved(cleaned !== value && value.trim() !== '');
        props.onPassword(cleaned);
    };

    const busy = phase === 'checking';
    return (
        <form
            className='mml-form'
            onSubmit={(e) => {
                e.preventDefault();
                props.onSubmit();
            }}
        >
            <h3 className='mml-step-title'>{'Введите данные для входа'}</h3>

            {provider?.server_editable && (
                <>
                    <ServerField
                        label='Сервер входящей почты (IMAP)'
                        value={props.imap}
                        onChange={(v) => {
                            props.onImap(v);
                            if (!props.smtp.host || props.smtp.host === props.imap.host) {
                                props.onSmtp({...props.smtp, host: v.host});
                            }
                        }}
                        disabled={busy}
                        defaultPort={993}
                    />
                    <ServerField
                        label='Сервер исходящей почты (SMTP)'
                        value={props.smtp}
                        onChange={props.onSmtp}
                        disabled={busy}
                        defaultPort={465}
                    />
                </>
            )}
            {provider && !provider.server_editable && (
                <div className='mml-hint mml-servers'>
                    {`Серверы: ${provider.imap.host}:${provider.imap.port} (IMAP), ${provider.smtp.host}:${provider.smtp.port} (SMTP)`}
                </div>
            )}

            <label className='mml-field'>
                <span className='mml-field__label'>{guide.loginLabel}</span>
                <input
                    className='mml-input'
                    type='text'
                    inputMode='email'
                    autoComplete='username'
                    spellCheck={false}
                    placeholder={guide.loginPlaceholder}
                    value={props.username}
                    disabled={busy}
                    onChange={(e) => props.onUsername(e.target.value.trim())}
                />
                <span className='mml-field__hint'>{guide.loginHint}</span>
            </label>

            <label className='mml-field'>
                <span className='mml-field__label'>{provider?.id === 'custom' ? 'Пароль (лучше — пароль приложения)' : 'Пароль для приложения'}</span>
                <div className='mml-input-group'>
                    <input
                        ref={passwordRef}
                        className='mml-input'
                        type={showPassword ? 'text' : 'password'}
                        autoComplete='new-password'
                        spellCheck={false}
                        placeholder='Вставьте скопированный пароль'
                        value={props.password}
                        disabled={busy}
                        onChange={(e) => onPasswordChange(e.target.value)}
                    />
                    <button
                        type='button'
                        className='mml-icon-btn'
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                        title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                    >
                        {showPassword ? <EyeOffIcon size={16}/> : <EyeIcon size={16}/>}
                    </button>
                </div>
                <span className='mml-field__hint'>
                    {spacesRemoved ? 'Пробелы убраны автоматически — так и должно быть.' : 'Не обычный пароль от почты. Хранится на сервере Mattermost в зашифрованном виде.'}
                </span>
            </label>

            {/* Submitting with Enter */}
            <button
                type='submit'
                hidden={true}
            />

            {phase !== 'idle' && phase !== 'error' && (
                <CheckProgress
                    phase={phase}
                    checked={props.checked}
                />
            )}
            {phase === 'error' && error && (
                <ErrorCard
                    error={error}
                    provider={provider}
                />
            )}
        </form>
    );
}

// CheckProgress shows what is happening during the (single) check request,
// so that a slow provider does not look like a frozen dialog.
function CheckProgress({phase, checked}: {phase: CheckPhase; checked: CheckResult | null}) {
    const [tick, setTick] = React.useState(0);
    React.useEffect(() => {
        if (phase !== 'checking') {
            return undefined;
        }
        const t = window.setInterval(() => setTick((x) => x + 1), 900);
        return () => window.clearInterval(t);
    }, [phase]);

    const items = ['Связываемся с почтовым сервером', 'Проверяем логин и пароль', 'Открываем «Входящие»', 'Проверяем отправку писем (SMTP)'];
    const active = phase === 'ok' ? items.length : Math.min(tick, items.length - 1);
    return (
        <ul
            className='mml-progress'
            aria-live='polite'
        >
            {items.map((text, i) => {
                let icon: React.ReactNode = <span className='mml-progress__dot'/>;
                if (i < active) {
                    icon = <CheckIcon size={14}/>;
                } else if (i === active) {
                    icon = <Spinner size={14}/>;
                }
                return (
                    <li
                        key={text}
                        className={i <= active ? 'mml-progress__item--active' : ''}
                    >
                        <span className='mml-progress__icon'>{icon}</span>
                        {text}
                    </li>
                );
            })}
            {phase === 'ok' && (
                <li className='mml-progress__ok'>
                    {checked ? `Всё получилось! Во «Входящих» ${pluralMessages(checked.total)}${checked.unseen ? `, непрочитанных — ${checked.unseen}` : ''}.` : 'Всё получилось!'}
                </li>
            )}
        </ul>
    );
}

function DoneStep({settings, botUsername, checked}: {settings: Settings; botUsername: string; checked: CheckResult | null}) {
    return (
        <div className='mml-done'>
            <div className='mml-done__check'><CheckIcon size={36}/></div>
            <h2>{'Почта подключена!'}</h2>
            <p className='mml-lead'>{'Она всегда под рукой — иконка почты на правой панели Mattermost.'}</p>
            {checked && checked.unseen > 0 && (
                <div className='mml-done__card'>
                    <InboxIcon size={18}/>
                    <span>{`Во «Входящих» непрочитанных: ${checked.unseen}`}</span>
                </div>
            )}
            <ul className='mml-benefits mml-benefits--compact'>
                {settings.notify_new && (
                    <li>
                        <BellIcon size={16}/>
                        <span>{`@${botUsername} сообщит о новых письмах`}</span>
                    </li>
                )}
                <li>
                    <SendIcon size={16}/>
                    <span>{'Любое сообщение — письмом: «Действия» (⋯) → «Отправить по почте»'}</span>
                </li>
                <li>
                    <MailIcon size={16}/>
                    <span>{'Команды: '}<code>{'/mail new'}</code>{', '}<code>{'/mail inbox'}</code>{', '}<code>{'/mail help'}</code></span>
                </li>
            </ul>
        </div>
    );
}
