package api

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/layout"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
)

type ArchiveMeta struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Size         int64     `json:"size"`
	CreatedAt    time.Time `json:"created_at"`
	Path         string    `json:"path"`
	Ref          string    `json:"ref"`
	Architecture string    `json:"architecture,omitempty"`
	OS           string    `json:"os,omitempty"`
	Tag          string    `json:"tag,omitempty"`
	Digest       string    `json:"digest,omitempty"`
}

var (
	archivesMu   sync.Mutex
	archivesMeta []ArchiveMeta
)

func (h *Handler) loadArchivesMeta() error {
	archivesMu.Lock()
	defer archivesMu.Unlock()

	path := h.getDataPath("archives.json")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		archivesMeta = []ArchiveMeta{}
		return nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	return json.Unmarshal(data, &archivesMeta)
}

func (h *Handler) saveArchivesMeta() error {
	archivesMu.Lock()
	defer archivesMu.Unlock()

	path := h.getDataPath("archives.json")
	data, err := json.MarshalIndent(archivesMeta, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0644)
}

func (h *Handler) ListArchives(c *gin.Context) {
	if err := h.loadArchivesMeta(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load archives metadata"})
		return
	}

	archivesMu.Lock()
	// Check if any repair is needed
	var needsSave bool
	for i := range archivesMeta {
		if repairArchiveMeta(&archivesMeta[i]) {
			needsSave = true
		}
	}

	list := make([]ArchiveMeta, len(archivesMeta))
	copy(list, archivesMeta)
	archivesMu.Unlock()

	if needsSave {
		_ = h.saveArchivesMeta()
	}

	c.JSON(http.StatusOK, list)
}

// UploadArchive handles uploading of one or multiple archives.
// It parses each archive, converts it to OCI Layout, and stores metadata.
func (h *Handler) UploadArchive(c *gin.Context) {
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid form data"})
		return
	}

	files := form.File["files"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No files uploaded"})
		return
	}

	var uploadedArchives []ArchiveMeta
	var errors []string

	for _, fileHeader := range files {
		// Generate ID
		id := fmt.Sprintf("archive_%d_%s", time.Now().UnixNano(), sanitizeName(fileHeader.Filename))
		baseDir := h.getDataPath("archives", id)
		if err := os.MkdirAll(baseDir, 0755); err != nil {
			errors = append(errors, fmt.Sprintf("%s: Failed to create directory", fileHeader.Filename))
			continue
		}

		// Save temp file
		tmpPath := filepath.Join(baseDir, "temp.tar")
		out, err := os.Create(tmpPath)
		if err != nil {
			errors = append(errors, fmt.Sprintf("%s: Failed to create temp file", fileHeader.Filename))
			continue
		}

		src, err := fileHeader.Open()
		if err != nil {
			out.Close()
			errors = append(errors, fmt.Sprintf("%s: Failed to open uploaded file", fileHeader.Filename))
			continue
		}

		_, err = io.Copy(out, src)
		src.Close()
		out.Close()
		if err != nil {
			errors = append(errors, fmt.Sprintf("%s: Failed to save uploaded file", fileHeader.Filename))
			continue
		}

		// Parse Metadata from Docker Manifest inside tar
		repoTags, err := extractRepoTags(tmpPath)
		if err != nil {
			// Non-fatal, just log
			fmt.Printf("Warning: failed to extract repo tags from %s: %v\n", fileHeader.Filename, err)
		}

		// Load as tarball image to get Config (Arch/OS)
		img, err := tarball.ImageFromPath(tmpPath, nil)
		if err != nil {
			errors = append(errors, fmt.Sprintf("%s: Invalid image archive: %v", fileHeader.Filename, err))
			os.RemoveAll(baseDir) // Cleanup
			continue
		}

		configFile, err := img.ConfigFile()
		if err != nil {
			errors = append(errors, fmt.Sprintf("%s: Failed to read image config: %v", fileHeader.Filename, err))
			os.RemoveAll(baseDir)
			continue
		}

		digest, _ := img.Digest()
		size, _ := img.Size()
		mediaType, _ := img.MediaType()

		// Write to OCI Layout (standardize storage)
		layoutPath := filepath.Join(baseDir, "layout")

		// Create a descriptor that includes platform information
		desc := v1.Descriptor{
			MediaType: mediaType,
			Size:      size,
			Digest:    digest,
			Platform: &v1.Platform{
				Architecture: configFile.Architecture,
				OS:           configFile.OS,
				OSVersion:    configFile.OSVersion,
				Variant:      configFile.Variant,
			},
		}

		idx := mutate.AppendManifests(empty.Index, mutate.IndexAddendum{
			Add:        img,
			Descriptor: desc,
		})

		if _, err := layout.Write(layoutPath, idx); err != nil {
			errors = append(errors, fmt.Sprintf("%s: Failed to write OCI layout: %v", fileHeader.Filename, err))
			os.RemoveAll(baseDir)
			continue
		}

		// Clean up temp file
		os.Remove(tmpPath)

		// Determine Name/Tag
		name := fileHeader.Filename
		tag := "latest"

		// Try to find better name/tag from RepoTags
		if len(repoTags) > 0 {
			parts := strings.Split(repoTags[0], ":")
			if len(parts) > 0 {
				name = parts[0]
			}
			if len(parts) > 1 {
				tag = parts[1]
			}
		} else {
			// Try to find version from labels if tag is default
			if v, ok := configFile.Config.Labels["org.opencontainers.image.version"]; ok && v != "" {
				tag = v
			} else if v, ok := configFile.Config.Labels["kwbase_version"]; ok && v != "" {
				tag = v
			}

			// Try to find name from labels if name is default (filename)
			if n, ok := configFile.Config.Labels["org.opencontainers.image.ref.name"]; ok && n != "" {
				name = n
			}
		}

		meta := ArchiveMeta{
			ID:           id,
			Name:         name,
			Size:         fileHeader.Size,
			CreatedAt:    time.Now(),
			Path:         layoutPath,
			Ref:          fmt.Sprintf("archive://%s", id),
			Architecture: configFile.Architecture,
			OS:           configFile.OS,
			Tag:          tag,
			Digest:       digest.String(),
		}

		uploadedArchives = append(uploadedArchives, meta)
	}

	// Update global state
	if len(uploadedArchives) > 0 {
		if err := h.loadArchivesMeta(); err == nil {
			archivesMu.Lock()
			// Prepend new archives
			archivesMeta = append(uploadedArchives, archivesMeta...)
			archivesMu.Unlock()
			_ = h.saveArchivesMeta()
		}
	}

	if len(uploadedArchives) == 0 && len(errors) > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"errors": errors})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":   "success",
		"uploaded": uploadedArchives,
		"errors":   errors,
	})
}

type MergeRequest struct {
	IDs        []string `json:"ids"`
	TargetName string   `json:"target_name"` // Optional
	TargetTag  string   `json:"target_tag"`  // Optional
}

func (h *Handler) MergeArchives(c *gin.Context) {
	var req MergeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	if len(req.IDs) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "At least 2 archives are required for merging"})
		return
	}

	if err := h.loadArchivesMeta(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load meta"})
		return
	}

	// Find source archives
	var sources []ArchiveMeta
	archivesMu.Lock()
	for _, id := range req.IDs {
		for _, m := range archivesMeta {
			if m.ID == id {
				sources = append(sources, m)
				break
			}
		}
	}
	archivesMu.Unlock()

	if len(sources) != len(req.IDs) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "One or more archives not found"})
		return
	}

	// Prepare new archive
	id := fmt.Sprintf("merged_%d", time.Now().UnixNano())
	baseDir := h.getDataPath("archives", id)
	layoutPath := filepath.Join(baseDir, "layout")

	if err := os.MkdirAll(baseDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create directory"})
		return
	}

	var adds []mutate.IndexAddendum
	var totalSize int64

	// Load images from source layouts
	for _, src := range sources {
		l, err := layout.ImageIndexFromPath(src.Path)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to load layout %s", src.Name)})
			os.RemoveAll(baseDir)
			return
		}

		idxManifest, err := l.IndexManifest()
		if err != nil || len(idxManifest.Manifests) == 0 {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Empty layout %s", src.Name)})
			os.RemoveAll(baseDir)
			return
		}

		// Iterate all manifests in the index.
		for _, desc := range idxManifest.Manifests {
			img, err := l.Image(desc.Digest)
			if err != nil {
				continue
			}

			adds = append(adds, mutate.IndexAddendum{
				Add:        img,
				Descriptor: desc, // Preserve platform info
			})
		}
		totalSize += src.Size
	}

	// Create merged index
	mergedIdx := mutate.AppendManifests(empty.Index, adds...)

	// Write to new Layout
	if _, err := layout.Write(layoutPath, mergedIdx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to write merged layout: %v", err)})
		os.RemoveAll(baseDir)
		return
	}

	// Determine new metadata
	name := sources[0].Name
	if req.TargetName != "" {
		name = req.TargetName
	}
	tag := sources[0].Tag
	if req.TargetTag != "" {
		tag = req.TargetTag
	}

	// Get merged manifest for preview/digest
	manifest, _ := mergedIdx.IndexManifest()
	digest, _ := mergedIdx.Digest()

	meta := ArchiveMeta{
		ID:           id,
		Name:         name,
		Size:         totalSize, // Approx
		CreatedAt:    time.Now(),
		Path:         layoutPath,
		Ref:          fmt.Sprintf("archive://%s", id),
		Tag:          tag,
		Digest:       digest.String(),
		Architecture: "multi-arch",
		OS:           "multi-os",
	}

	// Save
	archivesMu.Lock()
	archivesMeta = append([]ArchiveMeta{meta}, archivesMeta...)
	archivesMu.Unlock()

	if err := h.saveArchivesMeta(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save meta"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":   "success",
		"meta":     meta,
		"manifest": manifest,
	})
}

func (h *Handler) DeleteArchive(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ID required"})
		return
	}

	if err := h.loadArchivesMeta(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load meta"})
		return
	}

	archivesMu.Lock()
	var newMeta []ArchiveMeta
	var targetPath string
	found := false
	for _, m := range archivesMeta {
		if m.ID == id {
			targetPath = m.Path
			found = true
			continue
		}
		newMeta = append(newMeta, m)
	}
	archivesMeta = newMeta
	archivesMu.Unlock()

	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "Archive not found"})
		return
	}

	if err := h.saveArchivesMeta(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save meta"})
		return
	}

	// Delete directory (parent of layout)
	if targetPath != "" {
		parent := filepath.Dir(targetPath)
		if filepath.Base(filepath.Dir(parent)) == "archives" {
			os.RemoveAll(parent)
		}
	}

	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

// Helpers

func repairArchiveMeta(m *ArchiveMeta) bool {
	if m.Architecture != "" && m.OS != "" && m.Tag != "" && m.Tag != "latest" {
		return false
	}

	// Only try to repair if it looks like a single-image layout (not merged)
	// Merged archives have "multi-arch" which is fine.
	if m.Architecture == "multi-arch" {
		return false
	}

	l, err := layout.ImageIndexFromPath(m.Path)
	if err != nil {
		return false
	}

	idxManifest, err := l.IndexManifest()
	if err != nil || len(idxManifest.Manifests) == 0 {
		return false
	}

	// Get first image config
	img, err := l.Image(idxManifest.Manifests[0].Digest)
	if err != nil {
		return false
	}

	cfg, err := img.ConfigFile()
	if err != nil {
		return false
	}

	changed := false
	if m.Architecture == "" {
		m.Architecture = cfg.Architecture
		changed = true
	}
	if m.OS == "" {
		m.OS = cfg.OS
		changed = true
	}
	if m.Digest == "" {
		d, _ := img.Digest()
		m.Digest = d.String()
		changed = true
	}

	// Improve Tag if possible
	if m.Tag == "" || m.Tag == "latest" {
		if v, ok := cfg.Config.Labels["org.opencontainers.image.version"]; ok && v != "" {
			m.Tag = v
			changed = true
		} else if v, ok := cfg.Config.Labels["kwbase_version"]; ok && v != "" {
			m.Tag = v
			changed = true
		}
	}

	// Improve Name if possible
	if strings.HasSuffix(m.Name, ".tar") || strings.HasSuffix(m.Name, ".gz") {
		if n, ok := cfg.Config.Labels["org.opencontainers.image.ref.name"]; ok && n != "" {
			m.Name = n
			changed = true
		}
	}

	return changed
}

func sanitizeName(name string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			return r
		}
		return '_'
	}, name)
}

func extractRepoTags(tarPath string) ([]string, error) {
	f, err := os.Open(tarPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Handle gzip if needed
	// tarball.ImageFromPath handles it, but here we might need to be careful.
	// We'll try to sniff.
	var r io.Reader = f
	// Simple gzip check
	buff := make([]byte, 2)
	if _, err := f.Read(buff); err == nil && buff[0] == 0x1f && buff[1] == 0x8b {
		f.Seek(0, 0)
		gz, err := gzip.NewReader(f)
		if err == nil {
			defer gz.Close()
			r = gz
		} else {
			f.Seek(0, 0)
		}
	} else {
		f.Seek(0, 0)
	}

	tr := tar.NewReader(r)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}

		if header.Name == "manifest.json" {
			var manifest []struct {
				RepoTags []string `json:"RepoTags"`
			}
			if err := json.NewDecoder(tr).Decode(&manifest); err != nil {
				return nil, err
			}
			if len(manifest) > 0 {
				return manifest[0].RepoTags, nil
			}
			return nil, nil
		}
	}
	return nil, nil
}
