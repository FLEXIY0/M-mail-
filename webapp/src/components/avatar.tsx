import React from 'react';

import {avatarUrl as externalAvatarUrl} from '../api';
import {avatarColor, initials} from '../format';
import {useStore} from '../state';

// Photos of people: a colleague's from Mattermost, anyone else's from the
// avatar service of Mail.ru (through the plugin), otherwise the initials.

function mattermostAvatar(userId: string) {
    return `${window.basename || ''}/api/v4/users/${userId}/image`;
}

// Addresses known to have no photo: their initials show without another
// request.
const noPhoto = new Set<string>();

export function PersonAvatar({email, name, userId, size = 40, className = ''}: {
    email: string;
    name?: string;
    userId?: string;
    size?: number;
    className?: string;
}) {
    const photos = useStore((s) => Boolean(s.config?.sender_photos));
    const key = email.toLowerCase();
    const [loaded, setLoaded] = React.useState(false);
    const style = {width: size, height: size, fontSize: Math.round(size * 0.36)};
    if (userId) {
        return (
            <img
                className={`mml-avatar-img ${className}`}
                src={mattermostAvatar(userId)}
                alt=''
                style={style}
            />
        );
    }
    const external = photos && key.includes('@') && !noPhoto.has(key);
    return (
        <span
            className={`mml-message__avatar mml-person ${className}`}
            style={{...style, background: loaded ? 'transparent' : avatarColor({email, name})}}
            aria-hidden='true'
        >
            {!loaded && initials({email, name})}
            {external && (
                <img
                    src={externalAvatarUrl(key)}
                    alt=''
                    className={loaded ? 'mml-person__photo mml-person__photo--on' : 'mml-person__photo'}
                    onLoad={() => setLoaded(true)}
                    onError={() => {
                        noPhoto.add(key);
                        setLoaded(false);
                    }}
                />
            )}
        </span>
    );
}
