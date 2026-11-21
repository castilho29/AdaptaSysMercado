// Instalador do Mercado Online: extrai o programa numa pasta temporária e roda o instalar.ps1
// (o mesmo instalador de sempre: pergunta o modo, mantém os dados, cria atalhos e a tarefa).
// O manifesto embutido pede administrador (UAC) ao abrir.
package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	_ "embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

//go:embed payload.zip
var payload []byte

//go:embed versao.txt
var versao string

func extrair(dest string) error {
	z, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return err
	}
	for _, f := range z.File {
		p := filepath.Join(dest, filepath.FromSlash(f.Name))
		if !strings.HasPrefix(p, filepath.Clean(dest)+string(os.PathSeparator)) {
			return fmt.Errorf("caminho inválido no pacote: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(p, 0o755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		r, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(p)
		if err != nil {
			r.Close()
			return err
		}
		_, err = io.Copy(w, r)
		r.Close()
		w.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func esperar() {
	fmt.Print("\n  Pressione Enter para fechar...")
	bufio.NewReader(os.Stdin).ReadString('\n')
}

func main() {
	v := strings.TrimSpace(versao)
	exec.Command("cmd", "/c", "title Instalar Mercado Online "+v).Run()
	fmt.Println()
	fmt.Println("  ==============================================")
	fmt.Println("    Instalar / atualizar o Mercado Online")
	fmt.Println("    versao " + v)
	fmt.Println("  ==============================================")
	base := filepath.Join(os.TempDir(), "MercadoOnline-Setup")
	os.RemoveAll(base)
	dir := filepath.Join(base, "MercadoOnline")
	fmt.Println("\n  Preparando os arquivos...")
	if err := extrair(base); err != nil {
		fmt.Println("  [!] Nao consegui extrair os arquivos:", err)
		esperar()
		os.Exit(1)
	}
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(ps); err != nil {
		ps = "powershell.exe"
	}
	args := []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(dir, "instalar.ps1")}
	args = append(args, os.Args[1:]...) // ex.: MercadoOnline-Setup.exe -Modo manter
	cmd := exec.Command(ps, args...)
	cmd.Dir = dir
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err := cmd.Run()
	os.RemoveAll(base)
	if err != nil {
		fmt.Println("\n  [!] A instalacao terminou com erro:", err)
		fmt.Println("      Tire um print desta janela e mande para o suporte.")
	}
	esperar()
	if err != nil {
		os.Exit(1)
	}
}
