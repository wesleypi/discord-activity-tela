# Protótipo: compartilhar tela dentro de uma Discord Activity

Baseado em `discord/getting-started-activity`. Esta Activity responde a pergunta em aberto:
**o Discord deixa uma Activity capturar a tela (`getDisplayMedia`)?**

## O que a documentação já responde

Na página de rede das Activities (https://docs.discord.com/developers/activities/development-guides/networking):

> All network traffic is routed through the Discord Proxy [...] we currently only support websockets [...] **WebRTC is not supported.**

Por isso este protótipo **não usa WebRTC**. A tela é gravada em pedaços de 250 ms (`MediaRecorder`, WebM/VP8) e enviada
pelo WebSocket ao servidor. O servidor repassa os pedaços a quem está na mesma instância da Activity, e quem assiste
reproduz com `MediaSource`. O atraso fica em torno de 1 s, e todo o vídeo passa pelo seu servidor.

A documentação **não fala** de `getDisplayMedia` nem da Permissions Policy do iframe. Só o teste dentro do Discord responde isso.
A página de design também diz que "Activities are not for screen-sharing", porque o Discord já tem isso nativo.
Isso é uma diretriz de design, não um bloqueio técnico, mas indica que o Discord não vai facilitar.

## O que o protótipo faz
- Mostra um diagnóstico do ambiente: iframe, Electron, Permissions Policy `display-capture`, suporte a MediaRecorder/MediaSource.
- Botão **Compartilhar tela**: chama `getDisplayMedia` e registra o erro exato se falhar.
- Se a captura funcionar, transmite para todos na mesma Activity, inclusive quem entrar depois.
- **Copiar log** copia o diagnóstico para você colar na conversa.

Já testado fora do Discord, com três abas do Chromium: captura, transmissão em 1280x720 (~500 kbit/s),
entrada de alguém depois do início e parada da transmissão funcionam.
**Ainda falta testar dentro do Discord.**

## 1. Rodar localmente (fora do Discord)

```bash
cp example.env .env
cd server && npm install && npm run dev
```
Em outro terminal:
```bash
cd client && npm install && npm run dev
```
Abra `http://localhost:5173` em duas abas, clique em **Compartilhar tela** em uma delas e veja o vídeo aparecer na outra.

## 2. Configurar o app no Developer Portal

1. https://discord.com/developers/applications → **New Application**.
2. **OAuth2**: copie o Client ID e o Client Secret para o `.env`. Adicione o redirect `https://127.0.0.1`.
3. **Installation**: marque **User Install** e **Guild Install**.
4. **Activities → Settings**: ative **Enable Activities** e, em **Supported Platforms**, marque **Web** (que inclui o
   app desktop) e as outras plataformas em que for testar. A Activity não aparece em plataformas desmarcadas.
5. Inicie o túnel (o cliente e o servidor precisam estar rodando):
   ```bash
   cloudflared tunnel --url http://localhost:5173
   ```
6. **Activities → URL Mappings**: prefixo `/` → target `xxxx.trycloudflare.com` (sem `https://`).
   Atualize sempre que reiniciar o túnel, porque o endereço muda.
7. No Discord: **Configurações → Avançado → Modo desenvolvedor** ligado.

## 3. Testar no Discord

1. Num servidor seu, entre num canal de voz.
2. Clique no botão de foguete para abrir a lista de Activities e inicie o app (com o Modo desenvolvedor, os seus apps aparecem ali).
3. Clique em **Compartilhar tela** e depois em **Copiar log**.
4. **Repita no Discord pelo navegador** (discord.com/app no Chrome). O app desktop é Electron e pode
   se comportar diferente do navegador. Teste os dois.
5. Para testar a transmissão, uma segunda conta precisa entrar na mesma Activity. Essa conta tem que ser membro
   da equipe (Team) dona do app no Developer Portal.

Os logs do app aparecem no console das ferramentas de desenvolvedor. No Discord PTB: View → Developer → Toggle Developer Tools.

## Como interpretar o log

| Resultado | Significado |
|---|---|
| `Permissions Policy "display-capture": BLOQUEADO` | O iframe do Discord não libera a captura. A tela ao vivo não é possível; vá para o conteúdo sincronizado. |
| `getDisplayMedia falhou: NotAllowedError` sem aparecer seletor | A captura foi bloqueada pelo iframe ou pelo app. |
| `getDisplayMedia falhou: NotSupportedError` (desktop) | O Electron do Discord não oferece a captura. Veja se no navegador funciona. |
| `Captura OK` e `Transmitindo`, mas o outro lado não recebe nada | O WebSocket com dados binários não está passando pelo proxy, ou a outra pessoa não está na mesma instância. |
| `Captura OK` e o outro lado mostra `Recebendo transmissão` com kbit/s subindo | Funciona. |
| `Falha no WebSocket` | O URL mapping `/` está errado ou o servidor (porta 3001) não está rodando. |

## Arquivos alterados em relação ao template
- `client/main.js`: diagnóstico, autenticação no Discord, captura, gravação e reprodução.
- `client/style.css`, `client/index.html`: interface.
- `client/vite.config.js`: `allowedHosts` para o domínio do cloudflared.
- `server/server.js`: repasse dos pedaços de vídeo pelo WebSocket em `/api/ws` (dependência `ws`).
