package cli

import (
	"fmt"
	"log"
	"os"

	"github.com/guoxudong/horcrux/internal/engine"
	"github.com/guoxudong/horcrux/internal/vault"
	"github.com/spf13/cobra"
)

var (
	tarPath string
	tarDst  string
	tarCred string
)

var syncTarCmd = &cobra.Command{
	Use:   "sync-tar",
	Short: "Push a local Docker tarball to a remote registry",
	Run: func(cmd *cobra.Command, args []string) {
		if tarPath == "" || tarDst == "" {
			fmt.Println("Error: tarball path and destination reference are required")
			cmd.Help()
			return
		}

		key := os.Getenv("HORCRUX_SECRET")
		if key == "" {
			key = "12345678901234567890123456789012"
		}

		v, err := vault.NewVault("data/vault.enc", key)
		if err != nil {
			log.Fatalf("Failed to initialize vault: %v", err)
		}

		creds, _ := v.LoadCredentials()
		var dstAuth *vault.Credential
		for _, c := range creds {
			if c.Name == tarCred || c.ID == tarCred {
				dstAuth = &c
				break
			}
		}

		progress := make(chan engine.Progress)
		syncer := engine.NewSyncer(progress)

		go func() {
			for p := range progress {
				fmt.Printf("[%s] %s\n", p.Level, p.Message)
			}
		}()

		fmt.Printf("Pushing tarball %s to %s...\n", tarPath, tarDst)
		err = syncer.SyncTarball(tarPath, tarDst, dstAuth)
		close(progress)

		if err != nil {
			fmt.Printf("ERROR: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Tarball push completed successfully!")
	},
}

func init() {
	syncTarCmd.Flags().StringVarP(&tarPath, "file", "p", "", "Path to the Docker tarball")
	syncTarCmd.Flags().StringVarP(&tarDst, "to", "t", "", "Target image reference")
	syncTarCmd.Flags().StringVar(&tarCred, "dst-cred", "", "Target credential name or ID")

	rootCmd.AddCommand(syncTarCmd)
}
