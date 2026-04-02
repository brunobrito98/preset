Seu app é um sistema local de reajuste de preços para posto, focado em concentrador Horustech usando o protocolo DT214. Ele instala na máquina do usuário, sobe um serviço local, abre uma interface web local no navegador e permite:

login de usuários próprios do app
cadastro de usuários com permissão
configuração de concentrador e bicos
consulta de preços atuais
envio de reajuste de preços por nível
auditoria de quem fez cada reajuste
Como o app roda
Quando o usuário abre o sistema:

um executável local sobe um servidor HTTP local
esse servidor publica a interface em:
http://127.0.0.1:8780/horustech-preco_v3.html
junto disso sobe um proxy local WebSocket/TCP em:
ws://localhost:8765
a interface HTML acessa esse servidor local e usa o proxy para falar com o concentrador
O launcher foi preparado para:

evitar janela preta para o usuário
tentar abrir o navegador automaticamente
permitir fallback manual pelo endereço local
Como ele se comunica com o concentrador Horustech
A comunicação com a automação Horustech acontece assim:

a tela web gera os comandos DT214
a tela envia esses comandos por WebSocket para o proxy local
o proxy local abre um socket TCP no concentrador
o proxy repassa o comando e devolve a resposta para a interface
Protocolos usados:

reajuste com níveis:
comando 32
formato >?CCCC32BBNPPPPPPKK
leitura de preços:
comando 05, tipo 09
teste de status:
comando 01
Níveis de preço suportados:

nível 0: dinheiro / à vista
nível 1: crédito
nível 2: débito
Regras importantes já aplicadas:

número do bico é decimal, não hexadecimal
bicos aceitos de 1 a 99
checksum é calculado conforme o DT214
resposta de execução é validada
a consulta de preços não usa mais fallback fake para evitar mostrar valores errados
Como o app se comunica com o banco de dados
Agora o app usa PostgreSQL para persistência de segurança e auditoria.

Parâmetros atuais do banco:

porta: 1917
usuário técnico padrão: postgres
senha técnica: LZTsystem123*#
banco padrão: postgres
Durante a instalação:

o instalador pergunta o IP ou nome do servidor PostgreSQL
esse endereço é salvo em:
%ProgramData%\HorusTechTrocaPrecos\server-config.json
Exemplo do que fica salvo:

{
  "host": "192.168.0.10"
}
Na inicialização do app:

ele lê o arquivo server-config.json
monta a conexão com:
host: informado na instalação
port: 1917
user: postgres
password: LZTsystem123*#
database: postgres
conecta no PostgreSQL
cria automaticamente as tabelas do app se não existirem
Tabelas criadas automaticamente:

ht_app_users
ht_app_audit_logs
Tabela de usuários do app
A tabela ht_app_users guarda os usuários internos do sistema.

Ela registra:

id
username
salt da senha
hash da senha
ativo/inativo
superusuário
permissão de reajuste
data de criação
O app não usa mais a tabela usuarios do AutoSystem para login.

Como funciona o login
O login agora é próprio do aplicativo.

Superusuário inicial criado automaticamente:

usuário: autosystem
senha: postgres01*
Fluxo:

usuário digita login e senha na tela inicial
backend consulta ht_app_users
backend verifica a senha usando hash forte com PBKDF2 + salt
backend verifica se o usuário:
está ativo
é superusuário ou
tem permissão can_adjust_prices = true
se aprovado, cria uma sessão local no servidor do app
Endpoints usados internamente:

POST /api/login
GET /api/session
POST /api/logout
Gestão de usuários
Dentro do app existe uma área:

Configurações > Usuários do Aplicativo
Somente superusuário pode:

listar usuários
criar usuários
remover usuários
Cada usuário pode ser cadastrado com:

nome de usuário
senha
permissão para reajuste
status de superusuário
Se for superusuário:

automaticamente também pode reajustar preços
Auditoria
Toda vez que um reajuste é feito, o app grava no PostgreSQL na tabela ht_app_audit_logs.

Cada registro guarda:

usuário que fez a operação
id do usuário
tipo da ação
data/hora
payload em JSON com:
bico
combustível
níveis enviados
IP/porta do concentrador
sucesso ou falha
Também existe visualização no app em:

Configurações > Auditoria de Reajustes
Configuração operacional
Dentro do app o usuário pode configurar:

IP do concentrador
porta do concentrador
timeout
delay entre envios
casas decimais
nome do posto
CNPJ do posto
bicos do posto
combustível associado a cada bico
descrição opcional de cada bico
Fluxo de reajuste

usuário faz login
define os preços por combustível e por nível
consulta os preços atuais, se quiser
envia os reajustes
o app manda um comando 32 para cada nível de cada bico
valida ACK do concentrador
marca sucesso/falha na tela
grava auditoria no banco
Fluxo de consulta

usuário clica em consultar preços
o app envia 05/09 para cada bico
tenta interpretar a resposta real
só preenche a tela se a resposta for válida
Arquivos principais de entrega
Na sua pasta de entrega:

instalador:
horustech-precos-setup.exe
executável:
horustech-precos.exe
launcher oculto:
launch-horustech-hidden.vbs
ícone:
horustech-icon.ico
instruções:
LEIA-ME.txt
Resumo final
Hoje seu app:

fala com o concentrador Horustech via DT214
usa PostgreSQL para usuários e auditoria
pede o IP do servidor PostgreSQL na instalação
cria as tabelas automaticamente
tem superusuário inicial
permite cadastro de usuários internos
restringe acesso ao reajuste por permissão
audita quem fez cada reajuste