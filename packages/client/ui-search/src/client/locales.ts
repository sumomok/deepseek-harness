/** `search` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'search'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.aria': '搜索消息',
  'panel.placeholder': '搜索所有会话的消息',
  'panel.empty': '没有匹配的消息',
  'panel.idle': '输入关键词开始搜索',
  'panel.retry': '重试',
  'panel.loadMore': '继续加载',
  'panel.escape': 'Esc',
  'panel.loading': '搜索中…',
  'panel.preparing': '正在准备消息检索 {examined}/{total}',
  'panel.loadingMore': '加载更多…',
  'panel.error': '搜索失败',
  'panel.partial': '部分会话无法读取，结果可能不全',
  'panel.hint': '↑↓ 选择，Enter 打开，Esc 关闭',
  'result.count': '{count} 条结果',
  'result.countMore': '{count} 条结果 · 继续滚动加载更多',
  'result.untitled': '未命名会话',
  'result.openAria': '打开 {title} 的这条消息',
}

/** Complete key set every dictionary must cover. */
export type SearchKey = keyof typeof zh

/** English dictionary. */
export const en: Record<SearchKey, string> = {
  'panel.aria': 'Search messages',
  'panel.placeholder': 'Search messages across all sessions',
  'panel.empty': 'No matching messages',
  'panel.idle': 'Type to search',
  'panel.retry': 'Retry',
  'panel.loadMore': 'Load more',
  'panel.escape': 'Esc',
  'panel.loading': 'Searching…',
  'panel.preparing': 'Preparing message search {examined}/{total}',
  'panel.loadingMore': 'Loading more…',
  'panel.error': 'Search failed',
  'panel.partial': 'Some sessions could not be read; results may be incomplete',
  'panel.hint': '↑↓ to select, Enter to open, Esc to close',
  'result.count': '{count} results',
  'result.countMore': '{count} results · scroll for more',
  'result.untitled': 'Untitled session',
  'result.openAria': 'Open this message in {title}',
}

/** Japanese dictionary. */
export const ja: Record<SearchKey, string> = {
  'panel.aria': 'メッセージを検索',
  'panel.placeholder': 'すべてのセッションのメッセージを検索',
  'panel.empty': '一致するメッセージはありません',
  'panel.idle': 'キーワードを入力して検索',
  'panel.retry': '再試行',
  'panel.loadMore': 'さらに読み込む',
  'panel.escape': 'Esc',
  'panel.loading': '検索中…',
  'panel.preparing': 'メッセージ検索を準備中 {examined}/{total}',
  'panel.loadingMore': 'さらに読み込み中…',
  'panel.error': '検索に失敗しました',
  'panel.partial': '一部のセッションを読み取れず、結果が不完全な可能性があります',
  'panel.hint': '↑↓ 選択、Enter で開く、Esc で閉じる',
  'result.count': '{count} 件',
  'result.countMore': '{count} 件 · スクロールでさらに読み込む',
  'result.untitled': '無題のセッション',
  'result.openAria': '{title} でこのメッセージを開く',
}

/** Spanish dictionary. */
export const es: Record<SearchKey, string> = {
  'panel.aria': 'Buscar mensajes',
  'panel.placeholder': 'Buscar mensajes en todas las sesiones',
  'panel.empty': 'Ningún mensaje coincide',
  'panel.idle': 'Escribe para buscar',
  'panel.retry': 'Reintentar',
  'panel.loadMore': 'Cargar más',
  'panel.escape': 'Esc',
  'panel.loading': 'Buscando…',
  'panel.preparing': 'Preparando la búsqueda de mensajes {examined}/{total}',
  'panel.loadingMore': 'Cargando más…',
  'panel.error': 'La búsqueda falló',
  'panel.partial': 'No se pudieron leer algunas sesiones; los resultados pueden estar incompletos',
  'panel.hint': '↑↓ para elegir, Enter para abrir, Esc para cerrar',
  'result.count': '{count} resultados',
  'result.countMore': '{count} resultados · desplázate para ver más',
  'result.untitled': 'Sesión sin título',
  'result.openAria': 'Abrir este mensaje en {title}',
}

/** French dictionary. */
export const fr: Record<SearchKey, string> = {
  'panel.aria': 'Rechercher des messages',
  'panel.placeholder': 'Rechercher des messages dans toutes les sessions',
  'panel.empty': 'Aucun message correspondant',
  'panel.idle': 'Saisissez un mot-clé',
  'panel.retry': 'Réessayer',
  'panel.loadMore': 'Charger plus',
  'panel.escape': 'Esc',
  'panel.loading': 'Recherche…',
  'panel.preparing': 'Préparation de la recherche de messages {examined}/{total}',
  'panel.loadingMore': 'Chargement…',
  'panel.error': 'La recherche a échoué',
  'panel.partial': 'Certaines sessions sont illisibles ; les résultats peuvent être incomplets',
  'panel.hint': '↑↓ pour choisir, Entrée pour ouvrir, Échap pour fermer',
  'result.count': '{count} résultats',
  'result.countMore': '{count} résultats · faites défiler pour en voir plus',
  'result.untitled': 'Session sans titre',
  'result.openAria': 'Ouvrir ce message dans {title}',
}

/** German dictionary. */
export const de: Record<SearchKey, string> = {
  'panel.aria': 'Nachrichten durchsuchen',
  'panel.placeholder': 'Nachrichten in allen Sitzungen durchsuchen',
  'panel.empty': 'Keine passenden Nachrichten',
  'panel.idle': 'Suchbegriff eingeben',
  'panel.retry': 'Erneut versuchen',
  'panel.loadMore': 'Mehr laden',
  'panel.escape': 'Esc',
  'panel.loading': 'Suche läuft…',
  'panel.preparing': 'Nachrichtensuche wird vorbereitet {examined}/{total}',
  'panel.loadingMore': 'Weitere werden geladen…',
  'panel.error': 'Suche fehlgeschlagen',
  'panel.partial': 'Einige Sitzungen waren unlesbar; die Ergebnisse können unvollständig sein',
  'panel.hint': '↑↓ zum Auswählen, Enter zum Öffnen, Esc zum Schließen',
  'result.count': '{count} Treffer',
  'result.countMore': '{count} Treffer · zum Weiterscrollen',
  'result.untitled': 'Sitzung ohne Titel',
  'result.openAria': 'Diese Nachricht in {title} öffnen',
}

/** Russian dictionary. */
export const ru: Record<SearchKey, string> = {
  'panel.aria': 'Поиск сообщений',
  'panel.placeholder': 'Искать сообщения во всех сессиях',
  'panel.empty': 'Подходящих сообщений нет',
  'panel.idle': 'Введите запрос для поиска',
  'panel.retry': 'Повторить',
  'panel.loadMore': 'Загрузить ещё',
  'panel.escape': 'Esc',
  'panel.loading': 'Идёт поиск…',
  'panel.preparing': 'Подготовка поиска сообщений {examined}/{total}',
  'panel.loadingMore': 'Загрузка…',
  'panel.error': 'Поиск не удался',
  'panel.partial': 'Часть сессий не читается; результаты могут быть неполными',
  'panel.hint': '↑↓ — выбор, Enter — открыть, Esc — закрыть',
  'result.count': 'Результатов: {count}',
  'result.countMore': 'Результатов: {count} · прокрутите для продолжения',
  'result.untitled': 'Сессия без названия',
  'result.openAria': 'Открыть это сообщение в {title}',
}

/** Portuguese dictionary. */
export const pt: Record<SearchKey, string> = {
  'panel.aria': 'Pesquisar mensagens',
  'panel.placeholder': 'Pesquisar mensagens em todas as sessões',
  'panel.empty': 'Nenhuma mensagem correspondente',
  'panel.idle': 'Digite para pesquisar',
  'panel.retry': 'Tentar de novo',
  'panel.loadMore': 'Carregar mais',
  'panel.escape': 'Esc',
  'panel.loading': 'Pesquisando…',
  'panel.preparing': 'Preparando a pesquisa de mensagens {examined}/{total}',
  'panel.loadingMore': 'Carregando mais…',
  'panel.error': 'A pesquisa falhou',
  'panel.partial': 'Algumas sessões não puderam ser lidas; os resultados podem estar incompletos',
  'panel.hint': '↑↓ para escolher, Enter para abrir, Esc para fechar',
  'result.count': '{count} resultados',
  'result.countMore': '{count} resultados · role para ver mais',
  'result.untitled': 'Sessão sem título',
  'result.openAria': 'Abrir esta mensagem em {title}',
}
