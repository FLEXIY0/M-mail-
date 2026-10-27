import React from 'react';

import {AlertIcon} from './icons';
import {Details} from './ui';

import type {ApiError} from '../api';
import {explainError} from '../guides';
import {closeWizard} from '../state';
import type {Provider} from '../types';

export function ErrorCard({error, provider, compact}: {error: ApiError; provider?: Provider | null; compact?: boolean}) {
    const explained = explainError(error.code, provider, error.message, error.details);
    return (
        <div
            className={`mml-error-card ${compact ? 'mml-error-card--compact' : ''}`}
            role='alert'
        >
            <div className='mml-error-card__title'>
                <AlertIcon size={16}/>
                {explained.title}
            </div>
            <ul className='mml-error-card__tips'>
                {explained.tips.map((t) => <li key={t}>{t}</li>)}
            </ul>
            {error.details && error.code !== 'invalid_message' && (
                <Details summary='Технические подробности'>
                    <code className='mml-code'>{error.details}</code>
                </Details>
            )}
        </div>
    );
}

// HelpText shows the administrator's hint; channel names like ~mm-support
// become links that open the channel.
export function HelpText({text}: {text: string}) {
    const team = window.location.pathname.split('/')[1] || '';
    const open = (e: React.MouseEvent, channel: string) => {
        const path = `/${team}/channels/${channel}`;
        const history = (window as unknown as {WebappUtils?: {browserHistory?: {push: (p: string) => void}}}).WebappUtils?.browserHistory;
        if (history) {
            e.preventDefault();
            closeWizard();
            history.push(path);
        }
    };
    return (
        <>
            {text.split(/(~[a-z0-9][a-z0-9_-]*)/i).map((part, i) => {
                if (!part.startsWith('~') || !team) {
                    return part;
                }
                const channel = part.slice(1).toLowerCase();
                return (
                    <a
                        key={i} // eslint-disable-line react/no-array-index-key
                        href={`/${team}/channels/${channel}`}
                        onClick={(e) => open(e, channel)}
                    >
                        {part}
                    </a>
                );
            })}
        </>
    );
}
