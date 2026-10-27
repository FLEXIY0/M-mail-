import React from 'react';

import type {Provider, ProviderID} from './types';

// Provider specific texts for the wizard. Keeping them in one place makes it
// easy to adjust the wording when a provider changes its settings pages.

export interface Guide {
    subtitle: string;
    badge: string;
    badgeColor: string;
    passwordTitle: string;
    passwordButton: string;
    steps: React.ReactNode[];
    before?: React.ReactNode;
    trouble?: React.ReactNode[];
    loginLabel: string;
    loginPlaceholder: string;
    loginHint: string;
    errorTips: Partial<Record<string, string[]>>;
}

const b = (text: string) => <strong>{text}</strong>;

const mailRuTrouble = [
    <>{'Пароли для внешних приложений доступны, только если к аккаунту привязан номер телефона.'}</>,
    <>{'Если вход не проходит с новым паролем, откройте почту → '}{b('Настройки → Почтовые программы')}{' и проверьте, что доступ по протоколу IMAP разрешён.'}</>,
];

export const guides: Record<ProviderID, Guide> = {
    vkworkspace: {
        subtitle: 'Корпоративная почта компании в VK WorkSpace',
        badge: 'VK',
        badgeColor: '#0077ff',
        passwordTitle: 'Создайте пароль для приложения в VK WorkSpace',
        passwordButton: 'Открыть «Пароли для внешних приложений»',
        before: (
            <>
                {'Для подключения нужен '}
                {b('пароль для внешнего приложения')}
                {'. Он даёт доступ только к почте, основной пароль останется в секрете, а отозвать его можно в любой момент.'}
            </>
        ),
        steps: [
            <>{'Откройте почту VK WorkSpace → '}{b('Настройки → Безопасность → Пароли для внешних приложений')}{'. Для облачного VK WorkSpace — кнопка выше.'}</>,
            <>{'Нажмите '}{b('«Создать»')}{', назовите пароль '}{b('Mattermost')}{' и выберите доступ, в который входит '}{b('Почта (IMAP, SMTP)')}{'.'}</>,
            <>{'Скопируйте пароль — он показывается только один раз.'}</>,
            <>{'Нет такого пункта? Значит, администратор VK WorkSpace запретил внешние приложения. Попросите его включить их для вас.'}</>,
        ],
        trouble: mailRuTrouble,
        loginLabel: 'Рабочий адрес почты',
        loginPlaceholder: 'ivan@company.ru',
        loginHint: 'Полный рабочий адрес',
        errorTips: {
            unauthorized: [
                'Вставьте пароль для внешнего приложения, а не пароль от рабочей почты.',
                'Проверьте, что у пароля есть доступ к Почте (IMAP, SMTP).',
                'Если внешние приложения запрещены в компании — пароль не сработает, обратитесь к администратору VK WorkSpace.',
            ],
            imap_disabled: [
                'Откройте почту → «Настройки» → «Почтовые программы» и разрешите доступ по IMAP.',
                'Если пункта нет, доступ запретил администратор VK WorkSpace.',
            ],
        },
    },
    mailru: {
        subtitle: 'Личная почта @mail.ru, @inbox.ru, @list.ru, @bk.ru',
        badge: '@',
        badgeColor: '#005ff9',
        passwordTitle: 'Создайте пароль для приложения в Mail.ru',
        passwordButton: 'Открыть «Пароли для внешних приложений»',
        before: (
            <>
                {'Mail.ru не пускает сторонние приложения по обычному паролю. Нужен отдельный '}
                {b('пароль для внешнего приложения')}
                {' — его можно отозвать в любой момент.'}
            </>
        ),
        steps: [
            <>{'Нажмите кнопку выше — откроются настройки безопасности Mail.ru. Если попросит, войдите в почту.'}</>,
            <>{'Нажмите '}{b('«Создать»')}{', введите название, например '}{b('Mattermost')}{', и нажмите '}{b('«Продолжить»')}{'.'}</>,
            <>{'Выберите доступ, в который входит '}{b('Почта (IMAP, SMTP)')}{', и нажмите '}{b('«Продолжить»')}{'.'}</>,
            <>{'Скопируйте появившийся пароль — он показывается только один раз.'}</>,
        ],
        trouble: mailRuTrouble,
        loginLabel: 'Адрес почты',
        loginPlaceholder: 'ivan@mail.ru',
        loginHint: 'Полный адрес, вместе с @mail.ru',
        errorTips: {
            unauthorized: [
                'Вставьте пароль для внешнего приложения, а не обычный пароль от почты.',
                'У пароля должен быть доступ к Почте: пароль «только для Календаря» не подойдёт.',
                'Если пароль создавали давно, его могли отозвать — создайте новый.',
            ],
            imap_disabled: [
                'Откройте почту → «Настройки» → «Почтовые программы» и разрешите доступ по IMAP.',
            ],
        },
    },
    yandex: {
        subtitle: 'Яндекс ID и Яндекс 360 для бизнеса',
        badge: 'Я',
        badgeColor: '#fc3f1d',
        passwordTitle: 'Создайте пароль приложения в Яндекс ID',
        passwordButton: 'Открыть «Пароли приложений»',
        before: (
            <>
                {'Яндекс пускает почтовые программы по '}
                {b('паролю приложения')}
                {'. Он работает только для почты, и его можно удалить в любой момент.'}
            </>
        ),
        steps: [
            <>{'В Яндекс Почте откройте '}{b('Настройки → Почтовые программы')}{' и включите '}{b('«С сервера imap.yandex.ru по протоколу IMAP»')}{' и '}{b('«Пароли приложений и OAuth-токены»')}{'.'}</>,
            <>{'Нажмите кнопку выше — откроется Яндекс ID, раздел '}{b('«Пароли приложений»')}{'.'}</>,
            <>{'Нажмите '}{b('«Создать пароль»')}{', выберите тип '}{b('«Почта»')}{' и назовите его, например, '}{b('Mattermost')}{'.'}</>,
            <>{'Скопируйте пароль — он показывается только один раз.'}</>,
        ],
        loginLabel: 'Логин или адрес почты',
        loginPlaceholder: 'ivan@yandex.ru',
        loginHint: 'Логин Яндекса или полный адрес почты',
        errorTips: {
            unauthorized: [
                'Нужен пароль приложения с типом «Почта», а не пароль от Яндекс ID.',
                'Проверьте, что в настройках Почты → «Почтовые программы» включены IMAP и «Пароли приложений и OAuth-токены».',
                'В Яндекс 360 для бизнеса администратор организации мог запретить пароли приложений.',
            ],
            imap_disabled: [
                'В Яндекс Почте откройте «Настройки» → «Почтовые программы» и включите доступ по IMAP.',
            ],
        },
    },
    custom: {
        subtitle: 'Exchange, Dovecot, Zimbra, Gmail и другие',
        badge: 'IMAP',
        badgeColor: '#6b7280',
        passwordTitle: 'Подготовьте адреса серверов и пароль',
        passwordButton: '',
        before: (
            <>
                {'Подойдёт любая почта с доступом по '}
                {b('IMAP')}
                {' (чтение) и '}
                {b('SMTP')}
                {' (отправка). Понадобятся адреса серверов, логин и пароль — лучше отдельный пароль приложения.'}
            </>
        ),
        steps: [
            <>{'Узнайте адреса серверов у администратора или в настройках почты. Примеры:'}
                <ul className='mml-examples'>
                    <li>{'Своя почта компании: '}<code>{'mail.company.ru'}</code>{' — IMAP 993, SMTP 465'}</li>
                    <li>{'Exchange с включённым IMAP: '}<code>{'outlook.company.ru'}</code>{' — IMAP 993, SMTP 587 (STARTTLS)'}</li>
                    <li>{'Gmail: '}<code>{'imap.gmail.com'}</code>{' и '}<code>{'smtp.gmail.com'}</code>{', пароль приложения в настройках аккаунта Google'}</li>
                </ul>
            </>,
            <>{'Если включена двухфакторная аутентификация, создайте пароль приложения — обычный пароль сервер, скорее всего, не примет.'}</>,
        ],
        loginLabel: 'Логин',
        loginPlaceholder: 'ivan@company.ru',
        loginHint: 'Обычно это адрес почты, иногда — имя пользователя (DOMAIN\\ivan)',
        errorTips: {},
    },
};

export function guideFor(provider: Provider | undefined | null): Guide {
    return guides[(provider?.id || 'custom') as ProviderID] || guides.custom;
}

export interface ErrorExplanation {
    title: string;
    tips: string[];
}

// explainError turns an API error code into a title and concrete next steps.
export function explainError(code: string, provider: Provider | null | undefined, fallback: string, details = ''): ErrorExplanation {
    const guide = guideFor(provider);
    const specific = guide.errorTips[code] || [];
    const smtp = details.includes('smtp');

    switch (code) {
    case 'unauthorized': {
        const tips = specific.length ? [...specific] : [
            'Проверьте логин: чаще всего это полный адрес почты.',
            'Скопируйте пароль заново — легко захватить лишний символ.',
            'Если на сервере включена двухфакторная аутентификация, нужен отдельный пароль приложения.',
        ];
        if (smtp) {
            tips.unshift('Чтение почты (IMAP) работает, а отправка (SMTP) — нет: у пароля приложения может не быть доступа к отправке писем.');
        }
        return {title: 'Логин или пароль не подошли', tips};
    }
    case 'imap_disabled':
        return {title: 'Доступ из почтовых программ выключен', tips: specific.length ? specific : ['Включите доступ по IMAP в настройках почты или попросите администратора.']};
    case 'network':
    case 'timeout':
        return {title: smtp ? 'SMTP-сервер не отвечает' : 'Почтовый сервер не отвечает', tips: ['Проверьте адрес и порт сервера.', 'Попробуйте ещё раз через минуту.', 'Если ошибка повторяется, передайте администратору Mattermost: серверу Mattermost нужен исходящий доступ к почтовому серверу (порты 993 и 465 или 587).']};
    case 'tls':
        return {title: 'Не удалось установить защищённое соединение', tips: ['Проверьте тип шифрования: порт 993 и 465 — SSL/TLS, порт 143 и 587 — STARTTLS.', 'Если сертификат сервера самоподписанный, обратитесь к администратору.']};
    case 'server':
        return {title: 'Почтовый сервер вернул ошибку', tips: ['Попробуйте позже. Подробности — ниже.']};
    case 'invalid_server':
        return {title: 'Неверный адрес сервера', tips: ['Укажите только имя сервера, без https:// и путей, например imap.company.ru.', 'Порт — число: обычно 993 для IMAP и 465 или 587 для SMTP.']};
    case 'blocked_address':
        return {title: 'Адрес во внутренней сети запрещён', tips: ['Администратор Mattermost запретил подключение к внутренним адресам. Попросите его указать этот сервер в настройках плагина.']};
    case 'not_found':
        return {title: 'Письмо не найдено', tips: ['Возможно, его уже удалили или переместили в другую папку. Обновите список.']};
    case 'rejected':
        return {title: 'Сервер не принял письмо', tips: ['Проверьте адреса получателей.', fallback]};
    case 'too_large':
    case 'attachments_too_large':
        return {title: 'Письмо слишком большое', tips: ['Уменьшите вложения или отправьте файлы ссылкой.']};
    case 'invalid_message':
        return {title: 'Проверьте письмо', tips: [details || fallback]};
    case 'rate_limited':
        return {title: 'Слишком много попыток', tips: ['Подождите немного и попробуйте снова.']};
    case 'offline':
        return {title: 'Нет связи с Mattermost', tips: ['Проверьте подключение к интернету.']};
    case 'provider_disabled':
        return {title: 'Сервис отключён', tips: ['Администратор отключил этот сервис в настройках плагина.']};
    case 'not_connected':
        return {title: 'Почта не подключена', tips: ['Подключите почту на правой панели.']};
    case 'invalid_web_url':
        return {title: 'Неверный адрес сайта', tips: ['Адрес должен начинаться с https:// или http://, например https://e.mail.ru/.']};
    case 'reconnect':
        return {title: 'Нужно подключиться заново', tips: ['Сохранённый пароль больше не читается. Создайте новый пароль приложения и подключите почту снова.']};
    }
    return {title: 'Не получилось', tips: [fallback]};
}
