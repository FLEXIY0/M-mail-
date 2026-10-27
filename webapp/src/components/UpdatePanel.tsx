import React from 'react';

import {CheckIcon, ExternalIcon, Spinner} from './icons';
import {Button, Callout} from './ui';

import {api} from '../api';
import type {ApiError} from '../api';
import type {UpdateInfo} from '../types';

// ReleaseNotes renders the small Markdown subset GitHub release notes use:
// headings, bullet lists and plain paragraphs. No HTML is ever injected.
function ReleaseNotes({text}: {text: string}) {
    const blocks: React.ReactNode[] = [];
    let list: string[] = [];
    const flush = () => {
        if (list.length) {
            blocks.push(<ul key={`l${blocks.length}`}>{list.map((item, i) => <li key={i}>{item}</li>)}</ul>);
            list = [];
        }
    };
    const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) {
            flush();
            continue;
        }
        const bullet = (/^[-*+]\s+(.*)$/).exec(line);
        if (bullet) {
            list.push(clean(bullet[1]));
            continue;
        }
        flush();
        const heading = (/^#{1,6}\s+(.*)$/).exec(line);
        if (heading) {
            blocks.push(
                <div
                    key={`h${blocks.length}`}
                    className='mml-update__heading'
                >
                    {clean(heading[1])}
                </div>,
            );
        } else {
            blocks.push(<p key={`p${blocks.length}`}>{clean(line)}</p>);
        }
    }
    flush();
    return <div className='mml-update__notes'>{blocks}</div>;
}

function formatDate(iso?: string) {
    if (!iso) {
        return '';
    }
    return new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'long', year: 'numeric'}).format(new Date(iso));
}

// UpdatePanel is shown in System Console → Plugins → Calendar. It tells an
// administrator about new releases and links the file to upload by hand.
// The plugin does not install itself: a forced reinstall removes the running
// plugin first, and when it fails half way the plugin is left broken.
export default function UpdatePanel() {
    const [info, setInfo] = React.useState<UpdateInfo | null>(null);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState<string>('');

    const load = React.useCallback(async (refresh = false) => {
        setLoading(true);
        try {
            const res = await api.updateInfo(refresh);
            setInfo(res);
            setError('');
        } catch (e) {
            setError((e as ApiError).message);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        load();
    }, [load]);

    if (loading && !info) {
        return <div className='mml-update'><Spinner/></div>;
    }

    return (
        <div className='mml-update'>
            <div className='mml-update__row'>
                <span>{'Установлена версия '}<strong>{info?.current || '—'}</strong></span>
                <Button
                    size='sm'
                    variant='tertiary'
                    loading={loading}
                    onClick={() => load(true)}
                >
                    {'Проверить обновления'}
                </Button>
            </div>

            {info?.update_available && (
                <div className='mml-update__card'>
                    <div className='mml-update__title'>
                        {`Доступна версия ${info.latest}`}
                        {info.published_at && <span className='mml-muted mml-small'>{` · ${formatDate(info.published_at)}`}</span>}
                    </div>
                    {info.notes && <ReleaseNotes text={info.notes.slice(0, 3000)}/>}
                    <div className='mml-update__heading'>{'Как обновить'}</div>
                    <ol className='mml-update__steps'>
                        <li>
                            {'Скачайте файл '}
                            {info.asset_url ? (
                                <a
                                    className='mml-link'
                                    href={info.asset_url}
                                    target='_blank'
                                    rel='noopener noreferrer'
                                >
                                    {info.asset}
                                    <ExternalIcon size={12}/>
                                </a>
                            ) : <strong>{info.asset}</strong>}
                            {'. Архивы «Source code» на странице релиза не подходят.'}
                        </li>
                        <li>{'Плагины → Управление плагинами → «Загрузить плагин» → выберите этот файл.'}</li>
                        <li>{'На вопрос о замене ответьте «Перезаписать». Подключённые календари и настройки пользователей сохранятся.'}</li>
                    </ol>
                    {!info.uploads_enabled && (
                        <Callout
                            kind='warning'
                            title='Загрузка плагинов выключена'
                        >
                            {'Включите «Разрешить загрузку плагинов» в разделе «Управление плагинами» или установите файл на сервере командой mmctl plugin add --force.'}
                        </Callout>
                    )}
                    {info.url && (
                        <a
                            className='mml-link'
                            href={info.url}
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            {'Страница релиза на GitHub'}
                            <ExternalIcon size={12}/>
                        </a>
                    )}
                </div>
            )}

            {info && !info.update_available && !info.check_error && (
                <div className='mml-update__ok'>
                    <CheckIcon size={14}/>
                    {info.latest ? 'Установлена последняя версия.' : 'Релизов пока нет.'}
                </div>
            )}

            {info?.check_error && (
                <Callout
                    kind='warning'
                    title='Не удалось проверить обновления'
                >
                    {info.check_error}
                </Callout>
            )}
            {error && (
                <Callout
                    kind='error'
                    title='Ошибка'
                >
                    {error}
                </Callout>
            )}
            <div className='mml-hint'>{`Источник: ${info?.source || ''}. Новые версии появляются, когда на GitHub публикуется релиз.`}</div>
        </div>
    );
}
