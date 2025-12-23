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
	srcRefs  []string
	dstRef   string
	srcCreds []string
	dstCred  string
)

var syncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Synchronize a container image",
	Run: func(cmd *cobra.Command, args []string) {
		if len(srcRefs) == 0 || dstRef == "" {
			fmt.Println("Error: source and destination references are required")
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

		creds, err := v.LoadCredentials()
		if err != nil {
			log.Fatalf("Failed to load credentials: %v", err)
		}

		// Map credentials
		credMap := make(map[string]vault.Credential)
		for _, c := range creds {
			credMap[c.Name] = c
			credMap[c.ID] = c
		}

		var dstAuth *vault.Credential
		if c, ok := credMap[dstCred]; ok {
			dstAuth = &c
		}

		progress := make(chan engine.Progress)
		syncer := engine.NewSyncer(progress)

		go func() {
			for p := range progress {
				fmt.Printf("[%s] %s\n", p.Level, p.Message)
			}
		}()

		if len(srcRefs) > 1 {
			// Multi-source merge
			fmt.Printf("Merging %d sources into %s...\n", len(srcRefs), dstRef)
			var srcAuths []*vault.Credential
			for _, sc := range srcCreds {
				if c, ok := credMap[sc]; ok {
					srcAuths = append(srcAuths, &c)
				} else {
					srcAuths = append(srcAuths, nil)
				}
			}
			// Pad srcAuths if needed
			for len(srcAuths) < len(srcRefs) {
				srcAuths = append(srcAuths, nil)
			}

			err = syncer.MergeManifests(srcRefs, dstRef, srcAuths, dstAuth)
		} else {
			// Single source sync
			var srcAuth *vault.Credential
			if len(srcCreds) > 0 {
				if c, ok := credMap[srcCreds[0]]; ok {
					srcAuth = &c
				}
			}

			opts := engine.SyncOptions{
				SourceRef:  srcRefs[0],
				TargetRef:  dstRef,
				SourceAuth: srcAuth,
				TargetAuth: dstAuth,
			}
			err = syncer.SyncManifestList(opts)
		}

		close(progress)
		if err != nil {
			fmt.Printf("ERROR: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Operation completed successfully!")
	},
}

func init() {
	syncCmd.Flags().StringSliceVarP(&srcRefs, "from", "f", []string{}, "Source image references (can be multiple for merging)")
	syncCmd.Flags().StringVarP(&dstRef, "to", "t", "", "Target image reference")
	syncCmd.Flags().StringSliceVar(&srcCreds, "src-cred", []string{}, "Source credential names or IDs (comma separated)")
	syncCmd.Flags().StringVar(&dstCred, "dst-cred", "", "Target credential name or ID")

	rootCmd.AddCommand(syncCmd)
}
