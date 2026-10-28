import React from 'react';

import {AlertIcon, CheckIcon, CopyIcon} from './icons';
import {Button} from './ui';

import type {ApiError} from '../api';
import {api} from '../api';
import type {CollaboraCheck as CheckResult} from '../types';

function Copyable({text}: {text: string}) {
    const [copied, setCopied] = React.useState(false);
    return (
        <div className='mml-copyable'>
            <code>{text}</code>
            <button
                type='button'
                className='mml-icon-btn'
                title='Скопировать'
                aria-label='Скопировать'
                onClick={() => {
                    navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false));
                }}
            >
                {copied ? <CheckIcon size={14}/> : <CopyIcon size={14}/>}
            </button>
        </div>
    );
}

function stepClass(s: {ok: boolean; warn?: boolean}) {
    if (s.ok) {
        return 'mml-admin-check__ok';
    }
    return s.warn ? 'mml-admin-check__warn' : 'mml-admin-check__fail';
}

// CollaboraCheck is shown in the System Console under the Collabora address:
// it tells what works and what to ask the administrator of Collabora.
export default function CollaboraCheck() {
    const [result, setResult] = React.useState<CheckResult | null>(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);

    const run = async () => {
        setBusy(true);
        setError('');
        try {
            setResult(await api.collaboraCheck());
        } catch (e) {
            setError((e as ApiError).message);
        } finally {
            setBusy(false);
        }
    };

    const failed = result?.steps.some((s) => !s.ok && !s.warn);
    return (
        <div className='mml-admin-check'>
            <Button
                size='sm'
                loading={busy}
                onClick={run}
            >
                {'Проверить Collabora'}
            </Button>
            <span className='mml-muted mml-small'>{' Проверяется сохранённый адрес: сначала нажмите «Сохранить».'}</span>
            {error && <div className='mml-admin-check__error'>{error}</div>}
            {result && (
                <ul className='mml-admin-check__steps'>
                    {result.steps.map((s) => (
                        <li
                            key={s.title}
                            className={stepClass(s)}
                        >
                            {s.ok ? <CheckIcon size={14}/> : <AlertIcon size={14}/>}
                            <span>
                                <strong>{s.title}</strong>
                                {': '}
                                {s.text}
                                {s.detail && <span className='mml-muted'>{` (${s.detail})`}</span>}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {result?.alias_line && (failed || result.steps.some((s) => s.warn)) && (
                <div className='mml-admin-check__help'>
                    <div>{'Что передать администратору Collabora — чтобы она доверяла этому Mattermost:'}</div>
                    <div className='mml-muted mml-small'>{'Collabora в Docker — переменная окружения:'}</div>
                    <Copyable text={result.alias_line}/>
                    <div className='mml-muted mml-small'>{'Или в /etc/coolwsd/coolwsd.xml, раздел storage → wopi:'}</div>
                    <Copyable text={result.xml || ''}/>
                    <div className='mml-muted mml-small'>{'После изменения Collabora нужно перезапустить.'}</div>
                </div>
            )}
        </div>
    );
}
