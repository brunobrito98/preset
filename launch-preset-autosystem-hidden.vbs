Set shell = CreateObject("WScript.Shell")
currentDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = currentDir
shell.Run Chr(34) & currentDir & "\preset-autosystem.exe" & Chr(34), 0, False
WScript.Sleep 6000
shell.Run "http://127.0.0.1:8780/", 1, False
