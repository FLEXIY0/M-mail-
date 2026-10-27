import React from 'react';

import {ShareIcon, Spinner} from './icons';
import {ErrorCard} from './shared';
import {Button, Callout, Modal} from './ui';

import type {ApiError} from '../api';
import {api} from '../api';
import {closeShare, getReduxState, useStore} from '../state';
import type {Message} from '../types';

function currentChannel(): {id: string; name: string} | null {
    const state = getReduxState();
    const id: string = state?.entities?.channels?.currentChannelId || '';
    if (!id) {
        return null;
    }
    const channel = state.entities.channels.channels?.[id];
    let name = channel?.display_name || channel?.name || '';
    if (channel?.type === 'D') {
        name = 'личные сообщения';
    }
    return {id, name};
}

// ShareDialog posts an e-mail into the current channel, e.g. to discuss a
// customer's letter with the team.
export default function ShareDialog() {
    const ref = useStore((s) => s.share);
    const [msg, setMsg] = React.useState<Message | null>(null);
    const [comment, setComment] = React.useState('');
    const [withFile, setWithFile] = React.useState(true);
    const [sending, setSending] = React.useState(false);
    const [error, setError] = React.useState<ApiError | null>(null);
    const [channel, setChannel] = React.useState(currentChannel);

    React.useEffect(() => {
        setMsg(null);
        setError(null);
        setComment('');
        setChannel(currentChannel());
        if (ref) {
            api.message(ref.folder, ref.uid, true).then(setMsg).catch((e: ApiError) => setError(e));
        }
    }, [ref]);

    if (!ref) {
        return null;
    }

    const share = async () => {
        if (!channel) {
            return;
        }
        setSending(true);
        setError(null);
        try {
            await api.share(ref.folder, ref.uid, channel.id, '', comment, withFile);
            closeShare();
        } catch (e) {
            setError(e as ApiError);
        } finally {
            setSending(false);
        }
    };

    return (
        <Modal
            title='Отправить письмо в канал'
            onClose={closeShare}
            width={560}
            footer={(
                <div className='mml-wizard__footer'>
                    <div className='mml-wizard__help'/>
                    <div className='mml-wizard__buttons'>
                        <Button
                            variant='tertiary'
                            onClick={closeShare}
                        >
                            {'Отмена'}
                        </Button>
                        <Button
                            variant='primary'
                            loading={sending}
                            disabled={!channel || !msg}
                            onClick={share}
                        >
                            <ShareIcon size={14}/>
                            {'Опубликовать'}
                        </Button>
                    </div>
                </div>
            )}
        >
            {!channel && (
                <Callout kind='warning'>{'Откройте канал, в который нужно отправить письмо, и попробуйте снова.'}</Callout>
            )}
            {channel && (
                <p className='mml-lead'>
                    {'Письмо появится в канале '}
                    <strong>{channel.name}</strong>
                    {' от вашего имени: тема, отправитель и текст. Участники канала смогут обсудить его в треде.'}
                </p>
            )}
            {!msg && !error && <div className='mml-center'><Spinner/></div>}
            {msg && (
                <div className='mml-share-preview'>
                    <div><strong>{msg.subject || '(без темы)'}</strong></div>
                    <div className='mml-muted mml-small'>{`От: ${msg.from.map((a) => a.name || a.email).join(', ')}`}</div>
                </div>
            )}
            <label className='mml-field'>
                <span className='mml-field__label'>
                    {'Комментарий'}
                    <span className='mml-optional'>{' (необязательно)'}</span>
                </span>
                <textarea
                    className='mml-input mml-textarea'
                    rows={3}
                    placeholder='Например: коллеги, кто возьмёт?'
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                />
            </label>
            <label className='mml-checkbox'>
                <input
                    type='checkbox'
                    checked={withFile}
                    onChange={(e) => setWithFile(e.target.checked)}
                />
                {'Приложить само письмо файлом (.eml) — с вложениями и оформлением'}
            </label>
            {error && (
                <ErrorCard
                    error={error}
                    compact={true}
                />
            )}
        </Modal>
    );
}
