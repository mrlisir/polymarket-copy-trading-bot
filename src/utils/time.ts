const BEIJING_TZ = 'Asia/Shanghai';

const clockFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BEIJING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

export const formatBeijingClock = (date: Date = new Date()): string => clockFormatter.format(date);

export const formatBeijingDateTime = (date: Date): string => dateTimeFormatter.format(date);

export const formatBeijingDate = (date: Date = new Date()): string => dateFormatter.format(date);

