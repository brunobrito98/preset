#define MyAppName "Preset AutoSystem"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "AutoSystem"
#define MyAppExeName "preset-autosystem.exe"

[Setup]
AppId={{5F147E97-0D1D-4A89-98DA-6BDE29993B53}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Preset AutoSystem
DefaultGroupName=Preset AutoSystem
DisableProgramGroupPage=yes
LicenseFile=
OutputDir=dist
OutputBaseFilename=preset-autosystem-setup-w7
Compression=lzma
SolidCompression=yes
WizardStyle=modern
SetupIconFile=horustech-icon.ico
UninstallDisplayIcon={app}\horustech-icon.ico
MinVersion=6.1
; Windows 7 SP1 = versao 6.1

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na Área de Trabalho"; GroupDescription: "Atalhos:"; Flags: unchecked

[Files]
Source: "dist\preset-autosystem-w7.exe"; DestDir: "{app}"; DestName: "preset-autosystem.exe"; Flags: ignoreversion
Source: "horustech-icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "launch-preset-autosystem-hidden.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Preset AutoSystem"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch-preset-autosystem-hidden.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\horustech-icon.ico"
Name: "{autodesktop}\Preset AutoSystem"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch-preset-autosystem-hidden.vbs"""; WorkingDir: "{app}"; Tasks: desktopicon; IconFilename: "{app}\horustech-icon.ico"

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch-preset-autosystem-hidden.vbs"""; Description: "Abrir Preset AutoSystem"; Flags: nowait postinstall skipifsilent

[Code]
var
  DbHostPage: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  DbHostPage := CreateInputQueryPage(
    wpSelectDir,
    'Servidor PostgreSQL',
    'Informe o IP ou nome do servidor PostgreSQL',
    'Este aplicativo gravará usuários e auditoria em tabelas próprias no PostgreSQL. Informe o endereço do servidor para esta instalação.'
  );
  DbHostPage.Add('IP ou nome do servidor:', False);
  DbHostPage.Values[0] := '127.0.0.1';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigPath: string;
  ConfigContent: string;
begin
  if CurStep = ssPostInstall then
  begin
    ForceDirectories(ExpandConstant('{commonappdata}\PresetAutoSystem'));
    ConfigPath := ExpandConstant('{commonappdata}\PresetAutoSystem\server-config.json');
    ConfigContent :=
      '{' + #13#10 +
      '  "host": "' + DbHostPage.Values[0] + '"' + #13#10 +
      '}';
    SaveStringToFile(ConfigPath, ConfigContent, False);
  end;
end;
