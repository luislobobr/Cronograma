import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, setDoc, doc, collection, onSnapshot, addDoc, deleteDoc, query, collectionGroup, getDoc, getDocs, updateDoc, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";

// Variáveis Globais de Firebase
let firebaseApp;
let db;
let auth;
let storage;
let unsubscribeProjects = () => { };
let unsubscribeUsers = () => { };
let unsubscribeNotifications = () => { };
let unsubscribeSectors = () => { }; // NOVO: Listener de setores

// --- CONSTANTES E CONFIGURAÇÃO ---
const ALLOWED_DOMAIN = "@vinci-highways.com.br";

// SUAS CREDENCIAIS DO BANCO DE DADOS
const appId = "cronograma-85bf4";
const firebaseConfig = {
    apiKey: "AIzaSyDB_q9kdQGNiLf34PPZFL2YuBDOj7XdwkA",
    authDomain: "cronograma-85bf4.firebaseapp.com",
    projectId: "cronograma-85bf4",
    storageBucket: "cronograma-85bf4.firebasestorage.app",
    messagingSenderId: "802190123207",
    appId: "1:802190123207:web:adaf51b25010f677bbdee2"
};

// NOVO: Serviço para gerenciar tarefas
const taskService = {
    isTaskRunningToday: function (task) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const latestDates = dataService.getLatestDates(task);
        if (!latestDates.startDate || !latestDates.endDate) return false;

        const startDate = new Date(latestDates.startDate + 'T00:00:00');
        const endDate = new Date(latestDates.endDate + 'T00:00:00');

        // Verificar se hoje está entre início e término E status é "Em Andamento"
        return task.status === 'Em Andamento' &&
            today >= startDate &&
            today <= endDate;
    },

    getTodayRunningTasks: function (project) {
        if (!project || !project.tasks) return [];
        return project.tasks.filter(task => this.isTaskRunningToday(task));
    },

    // NOVA FUNÇÃO: Obter tarefas atrasadas
    getOverdueTasks: function (project) {
        if (!project || !project.tasks) return [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        return project.tasks.filter(task => {
            const latestDates = dataService.getLatestDates(task);
            if (!latestDates.endDate) return false;

            const endDate = new Date(latestDates.endDate + 'T00:00:00');
            return task.status !== 'Concluída' && endDate < today;
        });
    },

    // NOVA FUNÇÃO: Obter primeira tarefa do dia
    getFirstTodayTask: function (project) {
        const todayTasks = this.getTodayRunningTasks(project);
        if (todayTasks.length === 0) return null;

        // Ordenar por data de início e retornar a primeira
        return todayTasks.sort((a, b) => {
            const aStart = new Date(dataService.getLatestDates(a).startDate);
            const bStart = new Date(dataService.getLatestDates(b).startDate);
            return aStart - bStart;
        })[0];
    }
};

// dataService Interface
const dataService = {
    projects: [],
    users: [],
    sectors: [], // NOVO: Array para armazenar setores
    currentProjectId: null,
    userId: null,
    userRole: null,
    userSectorId: null, // NOVO: ID do setor do usuário
    isAuthReady: false,
    taskService: taskService, // NOVO: Adicionar serviço de tarefas
    notifications: [], // NOVO: Array para armazenar notificações

    // --- FIREBASE IMPLEMENTATIONS ---
    initFirebase: async () => {
        try {
            firebaseApp = initializeApp(firebaseConfig);
            db = getFirestore(firebaseApp);
            auth = getAuth(firebaseApp);
            storage = getStorage(firebaseApp); // NOVO: Inicializar Storage

            // Listener do estado de autenticação inicia o fluxo da UI
            onAuthStateChanged(auth, async (user) => {
                if (user && user.email?.endsWith(ALLOWED_DOMAIN)) {
                    // Usuário autenticado e com domínio correto
                    dataService.userId = user.uid;
                    dataService.isAuthReady = true;

                    await dataService.getUserProfile(user.uid);

                    uiService.showView('project-view');
                    document.getElementById('logged-in-container').classList.remove('hidden');
                    uiService.closeModal('auth-modal');
                    document.getElementById('loader').style.display = 'none';

                    dataService.listenToUsers();
                    dataService.listenToProjects();
                    dataService.listenToNotifications(); // NOVO: Iniciar listener de notificações
                    dataService.listenToSectors(); // NOVO: Iniciar listener de setores

                    uiService.updateUserRoleDisplay();
                } else {
                    // Nenhuma autenticação ou domínio inválido
                    dataService.userId = null;
                    dataService.isAuthReady = true;
                    dataService.projects = [];
                    dataService.userRole = null;
                    dataService.userSectorId = null; // NOVO: Limpar setor do usuário
                    dataService.sectors = []; // NOVO: Limpar setores
                    dataService.notifications = []; // NOVO: Limpar notificações

                    document.getElementById('logged-in-container').classList.add('hidden');
                    uiService.openModal('auth-modal');
                    document.getElementById('loader').style.display = 'none';
                    unsubscribeProjects();
                    unsubscribeUsers();
                    unsubscribeNotifications(); // NOVO: Parar listener de notificações
                    unsubscribeSectors(); // NOVO: Parar listener de setores
                }
            });
        } catch (error) {
            console.error("Erro na inicialização do Firebase:", error);
            uiService.showToast('Erro ao conectar ao banco de dados! Verifique a API Key e a configuração.', 'error');
            document.getElementById('loader').style.display = 'none';
        }
    },

    // --- USER MANAGEMENT ---
    getUserProfile: async (uid) => {
        const userDocRef = doc(db, 'users_data', uid);
        const userSnapshot = await getDoc(userDocRef);

        if (userSnapshot.exists()) {
            const userData = userSnapshot.data();
            dataService.userRole = userData.role || 'user';
            dataService.userSectorId = userData.sectorId || null;
            console.log(`👤 Perfil carregado: role=${dataService.userRole}, sectorId=${dataService.userSectorId}`);

            // NOVO: Atualizar último acesso
            await dataService.updateLastAccess(uid);
        } else {
            dataService.userRole = 'user';
            dataService.userSectorId = null;
        }
    },

    // NOVO: Atualizar timestamp de último acesso
    updateLastAccess: async (uid) => {
        try {
            await setDoc(doc(db, 'users_data', uid), {
                lastAccess: new Date().toISOString(),
                lastActivity: new Date().toISOString()
            }, { merge: true });
        } catch (error) {
            console.warn('Erro ao atualizar lastAccess:', error);
        }
    },

    listenToUsers: () => {
        unsubscribeUsers();
        if (!dataService.isAuthReady) return;

        const usersRef = collection(db, 'users_data');

        unsubscribeUsers = onSnapshot(usersRef, (snapshot) => {
            dataService.users = [];
            snapshot.forEach(doc => {
                if (doc.data().email && doc.data().email.endsWith(ALLOWED_DOMAIN)) {
                    dataService.users.push({ id: doc.id, ...doc.data() });
                }
            });

            if (document.getElementById('user-management-modal').classList.contains('modal-visible') && dataService.userRole === 'Gestor') {
                uiService.renderUserManagementTable();
            }
            uiService.populateAssignedUsersCheckboxes();
        }, (error) => {
            console.error("Erro ao ouvir usuários:", error);
        });
    },

    updateUserRole: async (uid, newRole) => {
        try {
            const userDocRef = doc(db, 'users_data', uid);
            await setDoc(userDocRef, { role: newRole }, { merge: true });

            await auth.currentUser.getIdToken(true);

            uiService.showToast(`Papel de ${dataService.users.find(u => u.id === uid)?.email} atualizado para ${newRole}.`);
        } catch (error) {
            console.error("Erro ao atualizar papel:", error);
            uiService.showToast('Falha ao atualizar papel do utilizador.', 'error');
        }
    },

    updateUser: async (uid, userData) => {
        try {
            const userDocRef = doc(db, 'users_data', uid);
            await setDoc(userDocRef, userData, { merge: true });

            const userIndex = dataService.users.findIndex(u => u.id === uid);
            if (userIndex !== -1) {
                dataService.users[userIndex] = { ...dataService.users[userIndex], ...userData };
            }

            if (uid === dataService.userId && userData.role) {
                dataService.userRole = userData.role;
                await auth.currentUser.getIdToken(true);
                uiService.updateUserRoleDisplay();
            }
        } catch (error) {
            console.error("Erro ao atualizar utilizador:", error);
            throw error;
        }
    },

    // --- GESTÃO DE SETORES (Admin) ---
    listenToSectors: () => {
        unsubscribeSectors();
        if (!dataService.isAuthReady) return;

        const sectorsRef = collection(db, 'sectors');

        unsubscribeSectors = onSnapshot(sectorsRef, (snapshot) => {
            dataService.sectors = [];
            snapshot.forEach(doc => {
                dataService.sectors.push({ id: doc.id, ...doc.data() });
            });
            console.log(`📁 Setores carregados: ${dataService.sectors.length}`);

            // Atualizar UI se modal de setores estiver aberto
            if (document.getElementById('sector-management-modal')?.classList.contains('modal-visible')) {
                uiService.renderSectorManagementTable();
            }

            // Atualizar dropdown de setores no formulário de projeto
            uiService.populateSectorDropdown();
        }, (error) => {
            console.error("Erro ao ouvir setores:", error);
        });
    },

    addSector: async (sectorData) => {
        try {
            const sectorsRef = collection(db, 'sectors');
            await addDoc(sectorsRef, {
                name: sectorData.name,
                description: sectorData.description || '',
                createdAt: new Date().toISOString(),
                createdBy: dataService.userId
            });
            uiService.showToast(`Setor "${sectorData.name}" criado com sucesso!`);
        } catch (error) {
            console.error("Erro ao criar setor:", error);
            uiService.showToast('Falha ao criar setor.', 'error');
            throw error;
        }
    },

    updateSector: async (sectorId, sectorData) => {
        try {
            const sectorRef = doc(db, 'sectors', sectorId);
            await setDoc(sectorRef, {
                name: sectorData.name,
                description: sectorData.description || '',
                updatedAt: new Date().toISOString(),
                updatedBy: dataService.userId
            }, { merge: true });
            uiService.showToast(`Setor "${sectorData.name}" atualizado com sucesso!`);
        } catch (error) {
            console.error("Erro ao atualizar setor:", error);
            uiService.showToast('Falha ao atualizar setor.', 'error');
            throw error;
        }
    },

    deleteSector: async (sectorId) => {
        try {
            // Verificar se existem projetos associados ao setor
            const projectsWithSector = dataService.projects.filter(p => p.sectorId === sectorId);
            if (projectsWithSector.length > 0) {
                uiService.showToast(`Não é possível excluir o setor. Existem ${projectsWithSector.length} projeto(s) associado(s).`, 'error');
                return false;
            }

            // Verificar se existem usuários associados ao setor
            const usersWithSector = dataService.users.filter(u => u.sectorId === sectorId);
            if (usersWithSector.length > 0) {
                uiService.showToast(`Não é possível excluir o setor. Existem ${usersWithSector.length} usuário(s) associado(s).`, 'error');
                return false;
            }

            const sectorRef = doc(db, 'sectors', sectorId);
            await deleteDoc(sectorRef);
            uiService.showToast('Setor excluído com sucesso!');
            return true;
        } catch (error) {
            console.error("Erro ao excluir setor:", error);
            uiService.showToast('Falha ao excluir setor.', 'error');
            return false;
        }
    },

    getSectorById: (sectorId) => {
        return dataService.sectors.find(s => s.id === sectorId);
    },

    // --- CADASTRO DE USUÁRIOS PELO GESTOR ---
    createUserByGestor: async (userData) => {
        try {
            const { name, email, role } = userData;

            if (!email.endsWith(ALLOWED_DOMAIN)) {
                throw new Error(`E-mail deve terminar com ${ALLOWED_DOMAIN}`);
            }

            // Verificar se usuário já existe
            const usersSnapshot = await getDocs(collection(db, 'users_data'));
            const existingUser = usersSnapshot.docs.find(doc => doc.data().email === email);

            if (existingUser) {
                throw new Error('Este e-mail já está cadastrado no sistema');
            }

            // MELHORIA 02: Usar nome do e-mail se nome não for fornecido
            const userName = name || email.split('@')[0];

            // Gerar senha temporária
            const tempPassword = Math.random().toString(36).slice(-8) + 'A1!';

            // Criar usuário no Authentication
            const userCredential = await createUserWithEmailAndPassword(auth, email, tempPassword);
            const newUserId = userCredential.user.uid;

            // Salvar dados do usuário no Firestore
            await setDoc(doc(db, 'users_data', newUserId), {
                name: userName,
                email: email,
                role: role,
                appId: appId,
                createdAt: new Date().toISOString(),
                createdBy: dataService.userId
            });

            // Enviar email de boas-vindas com instruções de login
            await dataService.sendWelcomeEmail(email, userName, tempPassword);

            // Fazer logout do usuário temporário criado
            await signOut(auth);

            // Refazer login do gestor
            const currentUser = auth.currentUser;
            if (currentUser) {
                await signInWithEmailAndPassword(auth, currentUser.email, document.getElementById('auth-password').value);
            }

            return { success: true, tempPassword };
        } catch (error) {
            console.error("Erro ao criar usuário:", error);
            throw error;
        }
    },

    sendWelcomeEmail: async (email, name, tempPassword) => {
        // Simulação de envio de email
        console.log(`📧 Email enviado para: ${email}`);
        console.log(`👋 Conteúdo do email:
            
            Olá ${name},
            
            Bem-vindo(a) ao Vinci Highways Projects!
            
            Sua conta foi criada com sucesso.
            
            Seus dados de acesso:
            E-mail: ${email}
            Senha temporária: ${tempPassword}
            
            Por segurança, recomendamos que altere sua senha no primeiro acesso.
            
            Acesse o sistema em: ${window.location.origin}
            
            Atenciosamente,
            Equipe Vinci Highways
        `);

        return true;
    },

    resetUserPassword: async (email) => {
        try {
            await sendPasswordResetEmail(auth, email);
            uiService.showToast(`Email de redefinição de senha enviado para ${email}`);
        } catch (error) {
            console.error("Erro ao enviar email de redefinição:", error);
            uiService.showToast('Falha ao enviar email de redefinição de senha.', 'error');
        }
    },

    // --- PROJECT DATA ACCESS ---
    getProjectCollectionRef: (uid) => {
        const targetUid = uid || dataService.userId;
        if (!targetUid) throw new Error("Usuário não autenticado.");
        return collection(db, 'artifacts', appId, 'users', targetUid, 'projects');
    },

    listenToProjects: () => {
        unsubscribeProjects();
        if (!dataService.isAuthReady) return;

        // ATUALIZADO: Usuários agora também podem ver projetos de outros onde são responsáveis
        // Usamos collectionGroup para buscar todos os projetos e filtrar depois
        let projectsQuery = query(collectionGroup(db, 'projects'));

        unsubscribeProjects = onSnapshot(projectsQuery, (snapshot) => {
            console.log("📦 Dados recebidos do Firebase:", snapshot.size, "documentos");

            snapshot.forEach(doc => {
                console.log("📄 Documento:", doc.id, doc.data());
            });

            let newProjects = [];
            snapshot.forEach(doc => {
                const projectData = doc.data();
                const creatorId = projectData.creatorId || doc.ref.parent.parent.id;

                const tasksWithDefaults = projectData.tasks?.map(t => ({
                    ...t,
                    assignedUsers: t.assignedUsers || [],
                })) || [];

                const project = {
                    id: doc.id,
                    manager: projectData.manager || 'Não Definido',
                    creatorId: creatorId,
                    tasks: tasksWithDefaults,
                    startDate: projectData.startDate || '', // NOVO: Data de início
                    endDate: projectData.endDate || '',     // NOVO: Data de término
                    dateMode: projectData.dateMode || 'manual', // NOVO: Modo de data (manual/auto)
                    ...projectData
                };
                newProjects.push(project);
            });

            // RBAC: Filtragem por role e setor
            const role = dataService.userRole?.toLowerCase();
            if (role === 'admin') {
                // Admin vê TUDO
                console.log('👑 Admin: acesso completo a todos os projetos');
            } else if (role === 'gestor') {
                // Gestor vê projetos do seu setor + legados (sem setor)
                newProjects = newProjects.filter(project => {
                    const inSector = !project.sectorId || project.sectorId === dataService.userSectorId;
                    return inSector;
                });
                console.log(`📁 Gestor: filtrando por setor ${dataService.userSectorId}`);
            } else {
                // User: vê projetos que criou ou foi atribuído (dentro do setor)
                newProjects = newProjects.filter(project => {
                    const inSector = !project.sectorId || !dataService.userSectorId || project.sectorId === dataService.userSectorId;
                    const isCreator = project.creatorId === dataService.userId;
                    const isAssigned = project.tasks.some(task =>
                        (task.assignedUsers || []).includes(dataService.userId)
                    );
                    return inSector && (isCreator || isAssigned);
                });
                console.log('👤 User: filtrando por criador/atribuído');
            }


            dataService.projects = newProjects;
            dataService.recalculateAllProgress();

            if (dataService.currentProjectId) {
                const currentProject = dataService.getProjectById(dataService.currentProjectId);
                if (currentProject) {
                    uiService.renderProjectDashboard(currentProject, document.getElementById('task-filter-input').value);
                } else {
                    App.showProjectView();
                }
            } else {
                App.showProjectView();
            }

            // Mostrar alertas de tarefas atrasadas e de hoje ao carregar
            setTimeout(() => {
                uiService.showLoginAlerts();
            }, 500);
        }, (error) => {
            console.error("Erro ao ouvir projetos:", error);
            uiService.showToast('Erro de sincronização em tempo real.', 'error');
        });
    },

    getLatestDates: (task) => {
        if (!task.dateHistory || task.dateHistory.length === 0) return { startDate: '', endDate: '' };
        return task.dateHistory[task.dateHistory.length - 1];
    },

    getProjectById: (id) => { return dataService.projects.find(p => p.id === id); },
    getCurrentProject: () => { return dataService.getProjectById(dataService.currentProjectId); },

    getProjectOwnerUid: (projectId) => {
        const project = dataService.getProjectById(projectId);
        return project ? project.creatorId : dataService.userId;
    },

    // --- CRUD HELPERS ---
    addProject: async (projectData) => {
        try {
            const projectCollection = dataService.getProjectCollectionRef();
            const newProjectData = {
                name: projectData.name,
                manager: projectData.manager,
                startDate: projectData.startDate, // NOVO: Salvar data de início
                endDate: projectData.endDate,     // NOVO: Salvar data de término
                dateMode: 'manual', // NOVO: Inicialmente manual
                sectorId: projectData.sectorId || null, // NOVO: ID do setor
                tasks: [],
                creatorId: dataService.userId
            };
            await addDoc(projectCollection, newProjectData);
        } catch (error) {
            console.error("Erro ao adicionar projeto:", error);
            uiService.showToast('Falha ao adicionar projeto.', 'error');
        }
    },

    // NOVA FUNÇÃO: Atualizar datas do projeto
    updateProjectDates: async (projectId, startDate, endDate, dateMode = 'manual') => {
        try {
            const project = dataService.getProjectById(projectId);
            if (!project) throw new Error('Projeto não encontrado');

            const ownerUid = dataService.getProjectOwnerUid(projectId);
            const projectDocRef = doc(dataService.getProjectCollectionRef(ownerUid), projectId);

            await setDoc(projectDocRef, {
                startDate: startDate,
                endDate: endDate,
                dateMode: dateMode
            }, { merge: true });

            return true;
        } catch (error) {
            console.error("Erro ao atualizar datas do projeto:", error);
            throw error;
        }
    },

    deleteProject: async (projectId) => {
        try {
            const ownerUid = dataService.getProjectOwnerUid(projectId);
            const projectDocRef = doc(dataService.getProjectCollectionRef(ownerUid), projectId);
            await deleteDoc(projectDocRef);
        } catch (error) {
            console.error("Erro ao deletar projeto:", error);
            uiService.showToast('Falha ao deletar projeto. Verifique suas permissões.', 'error');
        }
    },

    // Finalizar projeto (mover para finalizados)
    finalizeProject: async (projectId) => {
        try {
            const project = dataService.getProjectById(projectId);
            if (!project) return;

            const progress = dataService.getProjectProgress(project.tasks);
            if (progress < 100) {
                uiService.showToast('O projeto precisa estar 100% concluído para ser finalizado.', 'error');
                return;
            }

            project.finalized = true;
            project.finalizedAt = new Date().toISOString();
            await dataService.saveProjectDocument(project);
        } catch (error) {
            console.error("Erro ao finalizar projeto:", error);
            uiService.showToast('Falha ao finalizar projeto.', 'error');
        }
    },

    // Reabrir projeto (mover de volta para ativos)
    reopenProject: async (projectId) => {
        try {
            const project = dataService.getProjectById(projectId);
            if (!project) return;

            project.finalized = false;
            project.finalizedAt = null;
            await dataService.saveProjectDocument(project);
        } catch (error) {
            console.error("Erro ao reabrir projeto:", error);
            uiService.showToast('Falha ao reabrir projeto.', 'error');
        }
    },

    saveProjectDocument: async (project) => {
        try {
            const projectId = project.id;
            const ownerUid = project.creatorId;
            const projectDocRef = doc(dataService.getProjectCollectionRef(ownerUid), projectId);

            const projectData = {
                name: project.name,
                manager: project.manager,
                startDate: project.startDate,
                endDate: project.endDate,
                dateMode: project.dateMode || 'manual',
                tasks: project.tasks,
                creatorId: ownerUid,
                finalized: project.finalized || false,
                finalizedAt: project.finalizedAt || null,
                // NOVO: Rastrear última atualização para dashboard
                lastUpdatedAt: new Date().toISOString(),
                lastUpdatedBy: dataService.userId
            };

            await setDoc(projectDocRef, projectData, { merge: true });

        } catch (error) {
            console.error("Erro ao salvar projeto/tarefas:", error);
            uiService.showToast('Falha ao salvar dados. Verifique a conexão.', 'error');
        }
    },


    // NOVA FUNÇÃO: Calcular datas automáticas do projeto baseado nas tarefas
    calculateProjectDatesFromTasks: function (project) {
        if (!project.tasks || project.tasks.length === 0) {
            return { startDate: project.startDate, endDate: project.endDate };
        }

        // Encontrar a data de início mais antiga e data de término mais recente
        let earliestStartDate = null;
        let latestEndDate = null;

        project.tasks.forEach(task => {
            const taskDates = this.getLatestDates(task);
            if (taskDates.startDate && taskDates.endDate) {
                const taskStart = new Date(taskDates.startDate);
                const taskEnd = new Date(taskDates.endDate);

                if (!earliestStartDate || taskStart < earliestStartDate) {
                    earliestStartDate = taskStart;
                }
                if (!latestEndDate || taskEnd > latestEndDate) {
                    latestEndDate = taskEnd;
                }
            }
        });

        if (earliestStartDate && latestEndDate) {
            return {
                startDate: earliestStartDate.toISOString().split('T')[0],
                endDate: latestEndDate.toISOString().split('T')[0]
            };
        }

        return { startDate: project.startDate, endDate: project.endDate };
    },

    // NOVA FUNÇÃO: Verificar se projeto tem subtarefas
    projectHasSubtasks: function (project) {
        return project.tasks && project.tasks.some(task => task.parentId !== null && task.parentId !== undefined);
    },

    // NOVA FUNÇÃO: Verificar se tarefa tem subtarefas
    taskHasSubtasks: function (project, taskId) {
        return project.tasks && project.tasks.some(task => task.parentId === taskId);
    },

    // NOVA FUNÇÃO: Calcular datas automáticas de tarefa pai
    calculateParentTaskDates: function (project, parentTaskId) {
        const childTasks = project.tasks.filter(t => t.parentId === parentTaskId);
        if (childTasks.length === 0) return null;

        let earliestStartDate = null;
        let latestEndDate = null;

        childTasks.forEach(child => {
            const childDates = this.getLatestDates(child);
            if (childDates.startDate && childDates.endDate) {
                const childStart = new Date(childDates.startDate);
                const childEnd = new Date(childDates.endDate);

                if (!earliestStartDate || childStart < earliestStartDate) {
                    earliestStartDate = childStart;
                }
                if (!latestEndDate || childEnd > latestEndDate) {
                    latestEndDate = childEnd;
                }
            }
        });

        if (earliestStartDate && latestEndDate) {
            return {
                startDate: earliestStartDate.toISOString().split('T')[0],
                endDate: latestEndDate.toISOString().split('T')[0]
            };
        }

        return null;
    },

    // NOVA FUNÇÃO: Validar data de tarefa contra projeto
    validateTaskDateAgainstProject: function (taskStartDate, projectStartDate) {
        if (!taskStartDate || !projectStartDate) return true;

        const taskStart = new Date(taskStartDate);
        const projectStart = new Date(projectStartDate);

        return taskStart >= projectStart;
    },

    // NOVA FUNÇÃO: Validar data de subtarefa contra tarefa pai
    validateSubtaskDateAgainstParent: function (subtaskStartDate, parentStartDate) {
        if (!subtaskStartDate || !parentStartDate) return true;

        const subtaskStart = new Date(subtaskStartDate);
        const parentStart = new Date(parentStartDate);

        return subtaskStart >= parentStart;
    },

    // NOVA FUNÇÃO: Resolver conflito de datas ao re-parentar tarefa
    resolveReparentingDateConflict: async function (movingTaskId, newParentId) {
        const project = dataService.getCurrentProject();
        if (!project) return false;

        const movingTask = project.tasks.find(t => t.id === movingTaskId);
        const newParent = project.tasks.find(t => t.id === newParentId);

        if (!movingTask || !newParent) return false;

        const movingTaskDates = this.getLatestDates(movingTask);
        const parentDates = this.getLatestDates(newParent);

        // Verificar se há conflito
        if (new Date(movingTaskDates.startDate) < new Date(parentDates.startDate)) {
            // CONFLITO: A tarefa sendo movida começa antes da nova tarefa pai

            // Opção B: Aplicar roll-up automático
            const shouldUpdateParent = await uiService.showSubtaskDateConfirmModal(
                movingTask.name,
                movingTaskDates.startDate,
                movingTaskDates.endDate,
                parentDates.startDate,
                parentDates.endDate
            );

            if (shouldUpdateParent) {
                // Atualizar a tarefa pai para acomodar a subtarefa
                const updatedTasks = project.tasks.map(t => {
                    if (t.id === newParentId) {
                        const updatedTask = { ...t };
                        const newParentStart = new Date(Math.min(
                            parentStart.getTime(),
                            childStart.getTime()
                        )).toISOString().split('T')[0];
                        const newParentEnd = new Date(Math.max(
                            parentEnd.getTime(),
                            childEnd.getTime()
                        )).toISOString().split('T')[0];

                        if (updatedTask.dateHistory && updatedTask.dateHistory.length > 0) {
                            const latestDates = updatedTask.dateHistory[updatedTask.dateHistory.length - 1];
                            if (latestDates.startDate !== newParentStart || latestDates.endDate !== newParentEnd) {
                                updatedTask.dateHistory = [
                                    ...updatedTask.dateHistory,
                                    { startDate: newParentStart, endDate: newParentEnd }
                                ];
                            }
                        } else {
                            updatedTask.dateHistory = [{ startDate: newParentStart, endDate: newParentEnd }];
                        }
                        return updatedTask;
                    }
                    return t;
                });

                project.tasks = updatedTasks;
                return true;
            } else {
                // Usuário cancelou - não permitir o re-parenting
                return false;
            }
        }

        return true; // Sem conflito
    },

    // NOVA FUNÇÃO: Atualizar automaticamente datas do projeto quando em modo automático
    updateProjectDatesIfAuto: function (project) {
        if (project.dateMode === 'auto') {
            const calculatedDates = this.calculateProjectDatesFromTasks(project);
            if (calculatedDates.startDate !== project.startDate || calculatedDates.endDate !== project.endDate) {
                project.startDate = calculatedDates.startDate;
                project.endDate = calculatedDates.endDate;
                return true;
            }
        }
        return false;
    },

    // NOVA FUNÇÃO: Atualizar automaticamente datas de tarefas pai
    updateParentTaskDatesIfNeeded: function (project, taskId) {
        const task = project.tasks.find(t => t.id === taskId);
        if (!task || !task.parentId) return false;

        const parentTask = project.tasks.find(t => t.id === task.parentId);
        if (!parentTask) return false;

        const calculatedDates = this.calculateParentTaskDates(project, task.parentId);
        if (!calculatedDates) return false;

        const parentDates = this.getLatestDates(parentTask);
        if (calculatedDates.startDate !== parentDates.startDate || calculatedDates.endDate !== parentDates.endDate) {
            // Atualizar a tarefa pai
            const updatedTasks = project.tasks.map(t => {
                if (t.id === task.parentId) {
                    const updatedTask = { ...t };
                    if (updatedTask.dateHistory && updatedTask.dateHistory.length > 0) {
                        const latestDates = updatedTask.dateHistory[updatedTask.dateHistory.length - 1];
                        if (latestDates.startDate !== calculatedDates.startDate || latestDates.endDate !== calculatedDates.endDate) {
                            updatedTask.dateHistory = [
                                ...updatedTask.dateHistory,
                                { startDate: calculatedDates.startDate, endDate: calculatedDates.endDate }
                            ];
                        }
                    } else {
                        updatedTask.dateHistory = [{
                            startDate: calculatedDates.startDate,
                            endDate: calculatedDates.endDate
                        }];
                    }
                    return updatedTask;
                }
                return t;
            });

            project.tasks = updatedTasks;
            return true;
        }

        return false;
    },

    // FUNÇÃO saveTask CORRIGIDA - Atualiza hierarquia quando muda dependência
    saveTask: async (taskData) => {
        const project = dataService.getCurrentProject();
        if (!project) {
            uiService.showToast('Nenhum projeto selecionado.', 'error');
            return;
        }

        const { newStartDate, newEndDate, dependsOn, ...restOfTaskData } = taskData;

        // Validações básicas
        if (!newStartDate || !newEndDate) {
            uiService.showToast('Datas de início e término são obrigatórias.', 'error');
            return;
        }

        if (new Date(newStartDate) > new Date(newEndDate)) {
            uiService.showToast('Data de início não pode ser posterior à data de término!', 'error');
            return;
        }

        // Validação contra data do projeto
        if (project.startDate && new Date(newStartDate) < new Date(project.startDate)) {
            uiService.showToast(`A data de início não pode ser anterior à data do projeto (${new Date(project.startDate).toLocaleDateString('pt-BR')}).`, 'error');
            return;
        }

        // CORREÇÃO: Verificar se está mudando de tarefa independente para subtarefa
        const taskId = restOfTaskData.id;
        const existingTask = taskId ? project.tasks.find(t => t.id === taskId) : null;
        const isChangingToSubtask = existingTask && dependsOn && !existingTask.parentId;
        const isChangingFromSubtask = existingTask && !dependsOn && existingTask.parentId;

        let updatedTasks;

        if (taskId) {
            // EDITANDO tarefa existente
            updatedTasks = project.tasks.map(t => {
                if (t.id === taskId) {
                    const updatedTask = {
                        ...t,
                        ...restOfTaskData,
                        dependsOn: dependsOn || null,
                        // CORREÇÃO: Se está adicionando dependência, converter em subtarefa
                        parentId: dependsOn ? dependsOn : (restOfTaskData.parentId || null)
                    };

                    // Atualizar histórico de datas se mudou
                    const latestDates = dataService.getLatestDates(t);
                    if (latestDates.startDate !== newStartDate || latestDates.endDate !== newEndDate) {
                        updatedTask.dateHistory = [
                            ...(updatedTask.dateHistory || []),
                            { startDate: newStartDate, endDate: newEndDate }
                        ];
                    }

                    // CORREÇÃO: Recalcular ordem se mudou de hierarquia
                    if (isChangingToSubtask || isChangingFromSubtask) {
                        const siblings = project.tasks.filter(task =>
                            task.parentId === updatedTask.parentId &&
                            task.id !== updatedTask.id
                        );
                        updatedTask.order = siblings.length;
                    }

                    return updatedTask;
                }
                return t;
            });

            // Se está convertendo em subtarefa, ajustar automaticamente datas da tarefa pai se necessário
            if (isChangingToSubtask && dependsOn) {
                const parentTask = project.tasks.find(t => t.id === dependsOn);
                if (parentTask) {
                    try {
                        const parentDates = dataService.getLatestDates(parentTask);
                        if (parentDates && parentDates.startDate && parentDates.endDate) {
                            const parentStart = new Date(parentDates.startDate);
                            const parentEnd = new Date(parentDates.endDate);
                            const childStart = new Date(newStartDate);
                            const childEnd = new Date(newEndDate);

                            // Ajustar automaticamente as datas do pai para acomodar a subtarefa
                            if (childStart < parentStart || childEnd > parentEnd) {
                                const newParentStart = new Date(Math.min(parentStart.getTime(), childStart.getTime())).toISOString().split('T')[0];
                                const newParentEnd = new Date(Math.max(parentEnd.getTime(), childEnd.getTime())).toISOString().split('T')[0];

                                updatedTasks = updatedTasks.map(t => {
                                    if (t.id === dependsOn) {
                                        const updatedParent = { ...t };
                                        updatedParent.dateHistory = [
                                            ...(updatedParent.dateHistory || []),
                                            { startDate: newParentStart, endDate: newParentEnd }
                                        ];
                                        return updatedParent;
                                    }
                                    return t;
                                });
                            }
                        }
                    } catch (e) {
                        console.warn('Erro ao ajustar datas da tarefa pai:', e);
                    }
                }
            }
        } else {
            // NOVA tarefa
            const parentIdForNew = dependsOn ? dependsOn : (restOfTaskData.parentId || null);

            // Calcular ordem cronológica para a nova tarefa
            const siblingsOfNewTask = project.tasks.filter(t =>
                (t.parentId || null) === parentIdForNew
            );

            // Ordenar irmãos por data de início para encontrar posição cronológica
            const sortedSiblings = siblingsOfNewTask
                .map(t => ({
                    task: t,
                    startDate: new Date(dataService.getLatestDates(t).startDate)
                }))
                .sort((a, b) => a.startDate - b.startDate);

            // Encontrar posição cronológica baseada na data de início da nova tarefa
            const newTaskStartDate = new Date(newStartDate);
            let chronologicalOrder = 0;

            for (let i = 0; i < sortedSiblings.length; i++) {
                if (newTaskStartDate < sortedSiblings[i].startDate) {
                    chronologicalOrder = i;
                    break;
                }
                chronologicalOrder = i + 1;
            }

            const newTask = {
                ...restOfTaskData,
                id: Date.now() + Math.random(),
                dependsOn: dependsOn || null,
                parentId: parentIdForNew,
                dateHistory: [{ startDate: newStartDate, endDate: newEndDate }],
                comments: [],
                assignedUsers: restOfTaskData.assignedUsers || [],
                order: chronologicalOrder,
                manualOrder: false // Nova tarefa começa com ordem cronológica
            };

            // Reajustar ordem das tarefas irmãs que vêm depois
            const updatedSiblings = project.tasks.map(t => {
                if ((t.parentId || null) === parentIdForNew && (t.order || 0) >= chronologicalOrder) {
                    return { ...t, order: (t.order || 0) + 1 };
                }
                return t;
            });

            updatedTasks = [...updatedSiblings, newTask];

            // Ajustar automaticamente datas do pai se é uma nova subtarefa
            if (dependsOn) {
                const parentTask = project.tasks.find(t => t.id === dependsOn);
                if (parentTask) {
                    try {
                        const parentDates = dataService.getLatestDates(parentTask);
                        if (parentDates && parentDates.startDate && parentDates.endDate) {
                            const parentStart = new Date(parentDates.startDate);
                            const parentEnd = new Date(parentDates.endDate);
                            const childStart = new Date(newStartDate);
                            const childEnd = new Date(newEndDate);

                            // Ajustar automaticamente as datas do pai para acomodar a subtarefa
                            if (childStart < parentStart || childEnd > parentEnd) {
                                const newParentStart = new Date(Math.min(parentStart.getTime(), childStart.getTime())).toISOString().split('T')[0];
                                const newParentEnd = new Date(Math.max(parentEnd.getTime(), childEnd.getTime())).toISOString().split('T')[0];

                                updatedTasks = updatedTasks.map(t => {
                                    if (t.id === dependsOn) {
                                        const updatedParent = { ...t };
                                        updatedParent.dateHistory = [
                                            ...(updatedParent.dateHistory || []),
                                            { startDate: newParentStart, endDate: newParentEnd }
                                        ];
                                        return updatedParent;
                                    }
                                    return t;
                                });
                            }
                        }
                    } catch (e) {
                        console.warn('Erro ao ajustar datas da tarefa pai:', e);
                    }
                }
            }
        }

        // NOVO: Capturar tarefa salva ANTES de atualizar project.tasks para notificações
        let savedTaskForNotification = null;
        let newAssignedUsersForNotification = [];

        if (taskId) {
            // Editando tarefa existente
            savedTaskForNotification = updatedTasks.find(t => t.id === taskId);
            if (savedTaskForNotification && savedTaskForNotification.assignedUsers) {
                const existingAssignedUsers = existingTask?.assignedUsers || [];
                newAssignedUsersForNotification = savedTaskForNotification.assignedUsers.filter(uid => !existingAssignedUsers.includes(uid));
            }
        } else {
            // Nova tarefa - encontrar a tarefa recém criada pelo ID único gerado
            const originalTaskIds = new Set(project.tasks.map(t => t.id));
            savedTaskForNotification = updatedTasks.find(t => !originalTaskIds.has(t.id));
            if (savedTaskForNotification && savedTaskForNotification.assignedUsers) {
                newAssignedUsersForNotification = savedTaskForNotification.assignedUsers;
            }
        }

        // Atualizar projeto
        project.tasks = updatedTasks;

        // Recalcular progresso
        dataService.recalculateAllProgress();

        // Salvar no Firebase
        await dataService.saveProjectDocument(project);

        // NOVO: Enviar notificações para usuários atribuídos à tarefa
        if (savedTaskForNotification && newAssignedUsersForNotification.length > 0) {
            await dataService.sendTaskAssignmentNotifications(
                savedTaskForNotification.id,
                savedTaskForNotification.name,
                project.id,
                project.name,
                newAssignedUsersForNotification
            );
            console.log(`📨 Notificações de atribuição enviadas para ${newAssignedUsersForNotification.length} usuário(s)`);
        }

        // CORREÇÃO: Limpar estado de expansão para forçar re-renderização completa
        if (uiService.expandedTasks) {
            uiService.expandedTasks.clear();
        }

        // Fechar modal e mostrar feedback
        uiService.closeModal('task-modal');
        uiService.showToast('Tarefa salva com sucesso!', 'success');

        // Atualizar a interface
        const currentFilter = document.getElementById('task-filter-input').value;
        uiService.renderProjectDashboard(project, currentFilter);
    },
    // NOVA FUNÇÃO: Reordenar subtarefas via drag and drop
    reorderSubtasks: async function (parentTaskId, subtaskIdsInOrder) {
        const project = dataService.getCurrentProject();
        if (!project) return;

        const updatedTasks = project.tasks.map(task => {
            if (task.parentId === parentTaskId) {
                const newOrder = subtaskIdsInOrder.indexOf(task.id);
                if (newOrder !== -1) {
                    return { ...task, order: newOrder };
                }
            }
            return task;
        });

        project.tasks = updatedTasks;
        await dataService.saveProjectDocument(project);

        // Atualizar a UI
        uiService.renderProjectDashboard(project, document.getElementById('task-filter-input').value);
    },

    // MELHORIA 01: Função para atualizar datas da tarefa pai
    updateParentTaskDates: function (parentTaskId) {
        const project = dataService.getCurrentProject();
        if (!project) return;

        const parentTask = project.tasks.find(t => t.id === parentTaskId);
        if (!parentTask) return;

        const childTasks = project.tasks.filter(t => t.parentId === parentTaskId);
        if (childTasks.length === 0) return;

        // Encontrar a data de início mais antiga e data de término mais recente entre as subtarefas
        let earliestStartDate = null;
        let latestEndDate = null;

        childTasks.forEach(child => {
            const childDates = dataService.getLatestDates(child);
            const childStart = new Date(childDates.startDate);
            const childEnd = new Date(childDates.endDate);

            if (!earliestStartDate || childStart < earliestStartDate) {
                earliestStartDate = childStart;
            }
            if (!latestEndDate || childEnd > latestEndDate) {
                latestEndDate = childEnd;
            }
        });

        if (earliestStartDate && latestEndDate) {
            const parentDates = dataService.getLatestDates(parentTask);
            const parentStart = new Date(parentDates.startDate);
            const parentEnd = new Date(parentDates.endDate);

            // Atualizar apenas se as datas forem diferentes
            if (earliestStartDate.getTime() !== parentStart.getTime() ||
                latestEndDate.getTime() !== parentEnd.getTime()) {

                const newStartDate = earliestStartDate.toISOString().split('T')[0];
                const newEndDate = latestEndDate.toISOString().split('T')[0];

                // Atualizar a tarefa pai
                const updatedTasks = project.tasks.map(t => {
                    if (t.id === parentTaskId) {
                        const updatedTask = { ...t };
                        if (updatedTask.dateHistory && updatedTask.dateHistory.length > 0) {
                            const latestDates = updatedTask.dateHistory[updatedTask.dateHistory.length - 1];
                            if (latestDates.startDate !== newStartDate || latestDates.endDate !== newEndDate) {
                                updatedTask.dateHistory = [
                                    ...updatedTask.dateHistory,
                                    { startDate: newStartDate, endDate: newEndDate }
                                ];
                            }
                        } else {
                            updatedTask.dateHistory = [{ startDate: newStartDate, endDate: newEndDate }];
                        }
                        return updatedTask;
                    }
                    return t;
                });

                project.tasks = updatedTasks;
            }
        }
    },

    deleteTask: async (taskId) => {
        const project = dataService.getCurrentProject();
        if (!project) return;

        const idsToDelete = [taskId];
        const findChildren = (pid) => {
            project.tasks.filter(t => t.parentId === pid).forEach(c => {
                idsToDelete.push(c.id); findChildren(c.id);
            });
        };
        findChildren(taskId);

        let updatedTasks = project.tasks.filter(t => !idsToDelete.includes(t.id));

        updatedTasks = updatedTasks.map(t => {
            if (idsToDelete.includes(t.dependsOn)) { t.dependsOn = null; }
            return t;
        });

        project.tasks = updatedTasks;

        // ATUALIZAÇÃO AUTOMÁTICA: Atualizar datas do projeto se em modo automático
        dataService.updateProjectDatesIfAuto(project);

        dataService.recalculateAllProgress();
        await dataService.saveProjectDocument(project);
    },

    // --- CALCULATION LOGIC ---
    recalculateAllProgress: () => {
        dataService.projects.forEach(project => {
            const tasks = project.tasks;
            if (!tasks || tasks.length === 0) return;
            const taskMap = new Map(tasks.map(t => [t.id, t]));
            const childrenMap = new Map([...taskMap.keys()].map(k => [k, []]));
            tasks.forEach(t => { if (t.parentId && childrenMap.has(t.parentId)) childrenMap.get(t.parentId).push(t.id); });

            const calculateTaskProgress = (taskId) => {
                const childrenIds = childrenMap.get(taskId);
                const task = taskMap.get(taskId);
                if (!childrenIds || childrenIds.length === 0) return task.progress;

                const childrenProgress = childrenIds.map(childId => calculateTaskProgress(childId));
                const totalProgress = childrenProgress.reduce((sum, prog) => sum + prog, 0);
                const averageProgress = Math.round(totalProgress / childrenIds.length);

                task.progress = averageProgress;
                if (averageProgress === 100) task.status = 'Concluída';
                else if (averageProgress > 0) task.status = 'Em Andamento';
                else task.status = 'Não Iniciada';

                return averageProgress;
            };
            tasks.filter(t => t.parentId === null).forEach(t => calculateTaskProgress(t.id));
        });
    },
    getProjectProgress: (tasks) => {
        if (!tasks || tasks.length === 0) return 0;
        // ATUALIZADO: Calcular média de TODAS as tarefas (incluindo subtarefas)
        const totalProgress = tasks.reduce((sum, task) => sum + (task.progress || 0), 0);
        return Math.round(totalProgress / tasks.length);
    },

    // NOVA FUNÇÃO: Obter nome do responsável pelo UID
    getManagerName: (managerUid) => {
        if (!managerUid) return 'Não definido';
        const user = dataService.users.find(u => u.id === managerUid);
        return user ? (user.name || user.email.split('@')[0]) : `UID:${managerUid.substring(0, 4)}`;
    },

    // NOVA FUNÇÃO: Obter nomes dos usuários atribuídos
    getAssignedUserNames: (assignedUsers) => {
        if (!assignedUsers || assignedUsers.length === 0) return '-';
        return assignedUsers.map(uid => {
            const user = dataService.users.find(u => u.id === uid);
            return user ? (user.name || user.email.split('@')[0]) : `UID:${uid.substring(0, 4)}`;
        }).join(', ');
    },
    // NOVA FUNÇÃO: Processar importação com validação detalhada
    processImportWithValidation: async function (file) {
        try {
            const project = dataService.getCurrentProject();
            if (!project) {
                throw new Error('Nenhum projeto selecionado');
            }

            return new Promise((resolve, reject) => {
                const reader = new FileReader();

                reader.onload = async (e) => {
                    try {
                        const data = new Uint8Array(e.target.result);
                        const workbook = XLSX.read(data, { type: 'array' });

                        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                        const jsonData = XLSX.utils.sheet_to_json(worksheet);

                        if (jsonData.length === 0) {
                            throw new Error('A planilha está vazia');
                        }

                        const importResults = {
                            validTasks: [],
                            invalidTasks: [],
                            errors: [],
                            taskNameMap: new Map()
                        };

                        // Mapear tarefas existentes
                        project.tasks.forEach(task => {
                            importResults.taskNameMap.set(task.name.trim().toLowerCase(), task.id);
                        });

                        // Validar cada linha
                        jsonData.forEach((row, index) => {
                            const result = this.validateImportRow(row, index + 2, importResults.taskNameMap, project.startDate);
                            if (result.isValid) {
                                importResults.validTasks.push(result.task);
                                // Adicionar ao mapa para referência de tarefas pai
                                importResults.taskNameMap.set(result.task.name.trim().toLowerCase(), result.task.id);
                            } else {
                                importResults.invalidTasks.push({
                                    row: index + 2,
                                    data: row,
                                    errors: result.errors,
                                    task: result.task
                                });
                            }
                        });

                        // Se há tarefas inválidas, mostrar modal de ajustes
                        if (importResults.invalidTasks.length > 0) {
                            uiService.showImportAdjustmentModal(importResults);
                            resolve({ needsAdjustment: true, results: importResults });
                        } else {
                            // Todas válidas, importar diretamente
                            await this.finalizeImport(importResults.validTasks, project);
                            resolve({ needsAdjustment: false, count: importResults.validTasks.length });
                        }

                    } catch (error) {
                        reject(error);
                    }
                };

                reader.onerror = (error) => reject(error);
                reader.readAsArrayBuffer(file);
            });

        } catch (error) {
            console.error('Erro na importação:', error);
            throw error;
        }
    },

    // NOVA FUNÇÃO: Processar importação do MS Project
    // Mapeamento de colunas:
    // MS Project: Id, Ativo, Modo da Tarefa, Nome, Duração, Início, Término, Predecessoras, Nível da estrutura de tópicos, Anotações
    // Sistema: Tarefa, Data Início, Data Termino, Status, Progresso (%), Prioridade, Tarefa Pai
    processMSProjectImport: async function (file) {
        try {
            const project = dataService.getCurrentProject();
            if (!project) {
                throw new Error('Nenhum projeto selecionado');
            }

            return new Promise((resolve, reject) => {
                const reader = new FileReader();

                reader.onload = async (e) => {
                    try {
                        const data = new Uint8Array(e.target.result);
                        const workbook = XLSX.read(data, { type: 'array' });

                        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                        const jsonData = XLSX.utils.sheet_to_json(worksheet);

                        if (jsonData.length === 0) {
                            throw new Error('A planilha está vazia');
                        }

                        console.log('📊 Importação MS Project iniciada...');
                        console.log('Colunas encontradas:', Object.keys(jsonData[0]));

                        // Converter dados do MS Project para formato do sistema
                        const convertedData = this.convertMSProjectToStandardFormat(jsonData);

                        console.log(`✅ ${convertedData.length} tarefas convertidas do MS Project`);

                        const importResults = {
                            validTasks: [],
                            invalidTasks: [],
                            errors: [],
                            taskNameMap: new Map(),
                            msProjectIdMap: new Map() // Mapa de ID do MS Project para ID do sistema
                        };

                        // Mapear tarefas existentes
                        project.tasks.forEach(task => {
                            importResults.taskNameMap.set(task.name.trim().toLowerCase(), task.id);
                        });

                        // Validar cada linha convertida
                        convertedData.forEach((row, index) => {
                            const result = this.validateImportRow(row.converted, index + 2, importResults.taskNameMap, project.startDate);
                            if (result.isValid) {
                                // Manter referência do ID original do MS Project
                                result.task.msProjectId = row.originalId;
                                result.task.msProjectLevel = row.level;
                                importResults.validTasks.push(result.task);
                                importResults.taskNameMap.set(result.task.name.trim().toLowerCase(), result.task.id);
                                importResults.msProjectIdMap.set(row.originalId, result.task.id);
                            } else {
                                importResults.invalidTasks.push({
                                    row: index + 2,
                                    data: row.converted,
                                    errors: result.errors,
                                    task: result.task
                                });
                            }
                        });

                        // Resolver hierarquia (tarefas pai/filho) baseado no nível
                        this.resolveMSProjectHierarchy(importResults.validTasks);

                        // Se há tarefas inválidas, mostrar modal de ajustes
                        if (importResults.invalidTasks.length > 0) {
                            uiService.showImportAdjustmentModal(importResults);
                            resolve({ needsAdjustment: true, results: importResults });
                        } else {
                            // Todas válidas, importar diretamente
                            await this.finalizeImport(importResults.validTasks, project);
                            uiService.showToast(`MS Project: ${importResults.validTasks.length} tarefas importadas com sucesso!`, 'success');
                            resolve({ needsAdjustment: false, count: importResults.validTasks.length });
                        }

                    } catch (error) {
                        console.error('Erro na importação do MS Project:', error);
                        reject(error);
                    }
                };

                reader.onerror = (error) => reject(error);
                reader.readAsArrayBuffer(file);
            });

        } catch (error) {
            console.error('Erro na importação do MS Project:', error);
            throw error;
        }
    },

    // FUNÇÃO: Converter dados do MS Project para formato padrão
    convertMSProjectToStandardFormat: function (jsonData) {
        return jsonData.map((row, index) => {
            // Mapeamento de colunas MS Project -> Sistema
            const converted = {
                'Tarefa': row['Nome'] || row['Task Name'] || row['name'] || '',
                'Data Início': row['Início'] || row['Start'] || row['inicio'] || '',
                'Data Termino': row['Término'] || row['Finish'] || row['termino'] || row['Fim'] || '',
                'Status': 'Não Iniciada', // MS Project não tem status no mesmo formato
                'Progresso (%)': row['% Concluída'] || row['% Complete'] || row['Progresso'] || 0,
                'Prioridade': 'Média',
                'Atribuído a (Nomes Separados por Vírgula)': row['Nomes'] || row['Resource Names'] || '',
                'Risco (Sim/Nao)': 'Nao',
                'Tarefa Pai (Nome)': '' // Será resolvido depois pela hierarquia
            };

            // Converter progresso para número
            if (typeof converted['Progresso (%)'] === 'string') {
                converted['Progresso (%)'] = parseInt(converted['Progresso (%)'].replace('%', '')) || 0;
            }

            // Determinar status baseado no progresso
            const progress = converted['Progresso (%)'];
            if (progress >= 100) {
                converted['Status'] = 'Concluída';
            } else if (progress > 0) {
                converted['Status'] = 'Em Andamento';
            }

            return {
                converted: converted,
                originalId: row['Id'] || row['ID'] || row['id'] || index + 1,
                level: parseInt(row['Nível da estrutura de tópicos'] || row['Outline Level'] || row['nivel'] || 1),
                predecessors: row['Predecessoras'] || row['Predecessors'] || ''
            };
        }).filter(item => item.converted['Tarefa'] && item.converted['Tarefa'].toString().trim() !== '');
    },

    // FUNÇÃO: Resolver hierarquia de tarefas do MS Project
    resolveMSProjectHierarchy: function (tasks) {
        // Ordenar por nível para processar pais primeiro
        const sortedTasks = [...tasks].sort((a, b) => (a.msProjectLevel || 1) - (b.msProjectLevel || 1));

        // Stack para rastrear hierarquia
        const parentStack = [];

        sortedTasks.forEach((task, index) => {
            const level = task.msProjectLevel || 1;

            // Ajustar stack para o nível atual
            while (parentStack.length > 0 && parentStack[parentStack.length - 1].level >= level) {
                parentStack.pop();
            }

            // Se há um pai no stack, definir parentId
            if (parentStack.length > 0) {
                const parent = parentStack[parentStack.length - 1];
                task.parentId = parent.id;
            }

            // Adicionar tarefa atual ao stack como potencial pai
            parentStack.push({ id: task.id, level: level });
        });

        console.log('🔗 Hierarquia resolvida para', tasks.length, 'tarefas');
    },

    // NOVA FUNÇÃO: Processar importação do Excel Antigo (Formato Tecsidel)
    // Mapeamento de colunas:
    // B = Em Risco, C = Nome da Tarefa, D = Duração dias, E = Data Início, F = Data Término, G = Porcentagem, H = Status
    // Cabeçalho na linha 5, dados começam na linha 6
    processLegacyExcelImport: async function (file) {
        try {
            const project = dataService.getCurrentProject();
            if (!project) {
                throw new Error('Nenhum projeto selecionado');
            }

            return new Promise((resolve, reject) => {
                const reader = new FileReader();

                reader.onload = async (e) => {
                    try {
                        const data = new Uint8Array(e.target.result);
                        const workbook = XLSX.read(data, { type: 'array' });

                        const worksheet = workbook.Sheets[workbook.SheetNames[0]];

                        // Tentar encontrar a linha do header automaticamente
                        // Procurar por palavras-chave como "tarefa", "início", "status", etc.
                        let headerRow = 3; // Padrão: linha 4 (índice 3)

                        for (let tryRow = 0; tryRow <= 10; tryRow++) {
                            const testData = XLSX.utils.sheet_to_json(worksheet, { range: tryRow, header: 1 });
                            if (testData.length > 0 && testData[0]) {
                                const firstRowValues = testData[0].map(v => (v || '').toString().toLowerCase());
                                const hasTaskKeyword = firstRowValues.some(v =>
                                    v.includes('tarefa') || v.includes('atividade') || v.includes('nome')
                                );
                                const hasDateKeyword = firstRowValues.some(v =>
                                    v.includes('início') || v.includes('inicio') || v.includes('data')
                                );
                                const hasStatusKeyword = firstRowValues.some(v =>
                                    v.includes('status') || v.includes('situação')
                                );

                                if (hasTaskKeyword || (hasDateKeyword && hasStatusKeyword)) {
                                    headerRow = tryRow;
                                    console.log(`🔍 Header encontrado na linha ${tryRow + 1}:`, testData[0]);
                                    break;
                                }
                            }
                        }

                        // Ler a planilha a partir da linha do header
                        // IMPORTANTE: usar defval para incluir colunas com células vazias
                        const jsonData = XLSX.utils.sheet_to_json(worksheet, {
                            range: headerRow,
                            defval: '' // Incluir colunas mesmo se tiverem células vazias
                        });

                        if (jsonData.length === 0) {
                            throw new Error('A planilha está vazia ou não foi possível detectar os headers');
                        }

                        console.log('📊 Importação Excel Antigo (Tecsidel) iniciada...');
                        console.log('Colunas encontradas:', Object.keys(jsonData[0]));

                        // Converter dados do formato Tecsidel para formato do sistema
                        const convertedData = this.convertLegacyExcelToStandardFormat(jsonData);

                        console.log(`✅ ${convertedData.length} tarefas convertidas do Excel Antigo`);


                        const importResults = {
                            validTasks: [],
                            invalidTasks: [],
                            errors: [],
                            taskNameMap: new Map()
                        };

                        // Mapear tarefas existentes
                        project.tasks.forEach(task => {
                            importResults.taskNameMap.set(task.name.trim().toLowerCase(), task.id);
                        });

                        // Validar cada linha convertida
                        convertedData.forEach((row, index) => {
                            const result = this.validateImportRow(row, index + 6, importResults.taskNameMap, project.startDate);
                            if (result.isValid) {
                                importResults.validTasks.push(result.task);
                                importResults.taskNameMap.set(result.task.name.trim().toLowerCase(), result.task.id);
                            } else {
                                importResults.invalidTasks.push({
                                    row: index + 6,
                                    data: row,
                                    errors: result.errors,
                                    task: result.task
                                });
                            }
                        });

                        // Se há tarefas inválidas, mostrar modal de ajustes
                        if (importResults.invalidTasks.length > 0) {
                            uiService.showImportAdjustmentModal(importResults);
                            resolve({ needsAdjustment: true, results: importResults });
                        } else {
                            // Todas válidas, importar diretamente
                            await this.finalizeImport(importResults.validTasks, project);
                            uiService.showToast(`Excel Antigo: ${importResults.validTasks.length} tarefas importadas com sucesso!`, 'success');
                            resolve({ needsAdjustment: false, count: importResults.validTasks.length });
                        }

                    } catch (error) {
                        console.error('Erro na importação do Excel Antigo:', error);
                        reject(error);
                    }
                };

                reader.onerror = (error) => reject(error);
                reader.readAsArrayBuffer(file);
            });

        } catch (error) {
            console.error('Erro na importação do Excel Antigo:', error);
            throw error;
        }
    },

    // FUNÇÃO: Converter dados do Excel Antigo (Tecsidel) para formato padrão
    convertLegacyExcelToStandardFormat: function (jsonData) {
        // Detectar nomes das colunas (podem variar)
        const firstRow = jsonData[0] || {};
        const headers = Object.keys(firstRow);

        // Mapeamento flexível de colunas
        let columnMap = {
            taskName: null,
            startDate: null,
            endDate: null,
            duration: null,
            progress: null,
            status: null,
            risk: null
        };

        // Detectar colunas pelos nomes
        console.log('🔍 Headers encontrados para mapeamento:', headers);

        headers.forEach(h => {
            const hLower = h.toLowerCase().trim();

            // IMPORTANTE: Verificar 'tarefa pai' ANTES de verificar 'tarefa'
            // para que 'Tarefa pai' não seja capturado como nome da tarefa
            if (hLower.includes('pai') || hLower.includes('parent') || hLower.includes('mãe') || hLower.includes('mae')) {
                columnMap.parentTask = h;
                console.log(`  ✓ Coluna de tarefa pai detectada: "${h}"`);
            }
            // Só detectar como nome da tarefa se NÃO contiver 'pai'
            else if ((hLower.includes('tarefa') || hLower.includes('nome') || hLower.includes('atividade') || hLower.includes('descrição')) && !hLower.includes('pai')) {
                columnMap.taskName = h;
            }

            if ((hLower.includes('início') || hLower.includes('inicio')) && !columnMap.startDate) {
                columnMap.startDate = h;
            }
            if (hLower.includes('término') || hLower.includes('termino') || hLower.includes('fim')) {
                columnMap.endDate = h;
            }
            if (hLower.includes('duração') || hLower.includes('duracao')) {
                columnMap.duration = h;
            }
            if (hLower.includes('%') || hLower.includes('porcentagem') || hLower.includes('progresso') || hLower.includes('conclu')) {
                columnMap.progress = h;
            }
            if (hLower === 'status' || hLower.includes('situação') || hLower.includes('situacao')) {
                columnMap.status = h;
            }
            if (hLower.includes('risco')) {
                columnMap.risk = h;
            }
        });


        console.log('📋 Mapeamento de colunas detectado:', columnMap);

        return jsonData.map((row, index) => {
            // Obter valores usando o mapeamento
            const taskName = columnMap.taskName ? row[columnMap.taskName] : '';
            const startDate = columnMap.startDate ? row[columnMap.startDate] : '';
            const endDate = columnMap.endDate ? row[columnMap.endDate] : '';
            let progress = columnMap.progress ? row[columnMap.progress] : 0;
            let status = columnMap.status ? row[columnMap.status] : '';
            const risk = columnMap.risk ? row[columnMap.risk] : '';
            const parentTask = columnMap.parentTask ? row[columnMap.parentTask] : '';


            // Converter progresso para número
            if (typeof progress === 'string') {
                progress = parseInt(progress.replace('%', '').replace(',', '.')) || 0;
            }
            if (typeof progress === 'number' && progress <= 1 && progress > 0) {
                progress = Math.round(progress * 100);
            }

            // Mapear status para formato do sistema
            let normalizedStatus = 'Não Iniciada';
            if (status) {
                const statusLower = status.toString().toLowerCase().trim();
                if (statusLower.includes('conclu') || statusLower.includes('finaliz') || statusLower.includes('termin') || statusLower === '100%') {
                    normalizedStatus = 'Concluída';
                } else if (statusLower.includes('andamento') || statusLower.includes('progress') || statusLower.includes('execu') || statusLower.includes('iniciado')) {
                    normalizedStatus = 'Em Andamento';
                } else if (statusLower.includes('não') || statusLower.includes('nao') || statusLower.includes('pend') || statusLower.includes('aguar')) {
                    normalizedStatus = 'Não Iniciada';
                }
            }

            // Se não tem status mas tem progresso, inferir status
            if (!status && progress > 0) {
                if (progress >= 100) {
                    normalizedStatus = 'Concluída';
                } else {
                    normalizedStatus = 'Em Andamento';
                }
            }

            // Mapear risco
            let hasRisk = 'Nao';
            if (risk) {
                const riskLower = risk.toString().toLowerCase().trim();
                if (riskLower === 'sim' || riskLower === 's' || riskLower === 'yes' || riskLower === 'y' || riskLower === 'x' || riskLower === '1') {
                    hasRisk = 'Sim';
                }
            }

            return {
                'Tarefa': taskName || '',
                'Data Início': startDate || '',
                'Data Termino': endDate || '',
                'Status': normalizedStatus,
                'Progresso (%)': progress,
                'Prioridade': 'Média',
                'Atribuído a (Nomes Separados por Vírgula)': '',
                'Risco (Sim/Nao)': hasRisk,
                'Tarefa Pai (Nome)': parentTask || ''
            };

        }).filter(item => item['Tarefa'] && item['Tarefa'].toString().trim() !== '');
    },

    // FUNÇÃO: Validar linha individual (ATUALIZADA com validação de data do projeto)
    validateImportRow: function (row, rowNumber, taskNameMap, projectStartDate) {
        const errors = [];
        const task = {};

        // Validar nome da tarefa
        const taskName = row['Tarefa']?.toString().trim();
        if (!taskName) {
            errors.push('Nome da tarefa é obrigatório');
        } else {
            task.name = taskName;
        }

        // Validar e converter datas
        const startDate = this.parseExcelDate(row['Data Início']);
        const endDate = this.parseExcelDate(row['Data Termino']);

        if (!startDate) errors.push('Data de início inválida');
        if (!endDate) errors.push('Data de término inválida');

        if (startDate && endDate) {
            if (new Date(startDate) > new Date(endDate)) {
                errors.push('Data de início não pode ser posterior à data de término');
            } else {
                // NOVA VALIDAÇÃO: Verificar se data é anterior ao projeto
                if (projectStartDate && new Date(startDate) < new Date(projectStartDate)) {
                    errors.push(`Data de início não pode ser anterior à data do projeto (${new Date(projectStartDate).toLocaleDateString('pt-BR')})`);
                } else {
                    task.startDate = startDate;
                    task.endDate = endDate;
                }
            }
        }

        // Validar status
        const status = row['Status']?.toString().trim();
        const validStatuses = ['Não Iniciada', 'Em Andamento', 'Concluída'];
        if (status && validStatuses.includes(status)) {
            task.status = status;
        } else if (status) {
            errors.push(`Status inválido: "${status}". Use: ${validStatuses.join(', ')}`);
        } else {
            task.status = 'Não Iniciada';
        }

        // Validar progresso
        const progress = parseInt(row['Progresso (%)']) || 0;
        if (progress < 0 || progress > 100) {
            errors.push('Progresso deve estar entre 0 e 100');
        } else {
            task.progress = progress;
        }

        // Validar prioridade
        const priority = row['Prioridade']?.toString().trim();
        const validPriorities = ['Baixa', 'Média', 'Alta'];
        if (priority && validPriorities.includes(priority)) {
            task.priority = priority;
        } else if (priority) {
            errors.push(`Prioridade inválida: "${priority}". Use: ${validPriorities.join(', ')}`);
        } else {
            task.priority = 'Média';
        }

        // Processar responsáveis
        const assignedNames = row['Atribuído a (Nomes Separados por Vírgula)']?.toString();
        if (assignedNames) {
            task.assignedUsers = this.findUserIdsByNames(assignedNames.split(',').map(name => name.trim()));
            if (task.assignedUsers.length === 0) {
                errors.push('Nenhum responsável válido encontrado');
            }
        } else {
            task.assignedUsers = [];
        }

        // Validar risco
        const risk = row['Risco (Sim/Nao)']?.toString().trim().toLowerCase();
        task.risk = risk === 'sim';

        // Processar tarefa pai (OPCIONAL - não é erro se não encontrada)
        const parentTaskName = row['Tarefa Pai (Nome)']?.toString().trim();
        if (parentTaskName) {
            task.parentId = taskNameMap.get(parentTaskName.toLowerCase());
            // Se não encontrou ainda, guardar o nome para resolver depois
            if (!task.parentId) {
                task.parentTaskName = parentTaskName;
                // NÃO adicionar erro - será resolvido após todas as tarefas serem processadas
                console.log(`⚠️ Tarefa pai "${parentTaskName}" será resolvida após importação`);
            }
        } else {
            task.parentId = null;
        }


        // CORREÇÃO: Gerar ID único usando Math.random() para evitar duplicação
        task.id = Date.now() + Math.random();
        task.comments = [];
        task.dateHistory = [{ startDate: task.startDate, endDate: task.endDate }];

        return {
            isValid: errors.length === 0,
            task: task,
            errors: errors
        };
    },

    // FUNÇÃO: Finalizar importação
    finalizeImport: async function (validTasks, project) {
        // Adicionar tarefas ao projeto
        project.tasks = [...project.tasks, ...validTasks];

        // NOVO: Resolver parentIds pendentes (tarefas que referenciam pais pelo nome)
        const allTasks = project.tasks;
        const taskNameToId = new Map();
        allTasks.forEach(t => {
            if (t.name) {
                taskNameToId.set(t.name.toLowerCase().trim(), t.id);
            }
        });

        console.log('📊 Mapa de tarefas disponíveis:', Array.from(taskNameToId.keys()));

        let resolvedCount = 0;
        let unresolvedCount = 0;
        let unresolvedNames = [];

        validTasks.forEach(task => {
            // Log para TODAS as tarefas mostrando seu parentTaskName
            if (task.parentTaskName) {
                console.log(`🔍 Tarefa "${task.name}" procurando pai: "${task.parentTaskName}"`);
            }

            if (task.parentTaskName && !task.parentId) {
                const searchName = task.parentTaskName.toLowerCase().trim();
                const parentId = taskNameToId.get(searchName);

                console.log(`🔎 Buscando "${searchName}" no mapa...`, parentId ? 'ENCONTRADO!' : 'NÃO ENCONTRADO');

                if (parentId) {
                    task.parentId = parentId;
                    resolvedCount++;
                    console.log(`✅ Tarefa pai resolvida: "${task.name}" -> "${task.parentTaskName}" (ID: ${parentId})`);
                } else {
                    unresolvedCount++;
                    unresolvedNames.push(`"${task.parentTaskName}" (para: ${task.name})`);
                    console.warn(`⚠️ Tarefa pai NÃO encontrada: "${task.parentTaskName}" para tarefa "${task.name}"`);
                }
                delete task.parentTaskName; // Limpar campo temporário
            }
        });

        // Resumo final
        console.log('═══════════════════════════════════════');
        console.log(`📋 RESUMO DA IMPORTAÇÃO:`);
        console.log(`   Total de tarefas: ${validTasks.length}`);
        console.log(`   Hierarquias resolvidas: ${resolvedCount}`);
        console.log(`   Tarefas pai não encontradas: ${unresolvedCount}`);
        if (unresolvedNames.length > 0) {
            console.log(`   Nomes não encontrados:`, unresolvedNames);
        }
        console.log('═══════════════════════════════════════');

        if (unresolvedCount > 0) {
            uiService.showToast(`${unresolvedCount} tarefas pai não encontradas. Verifique o console (F12) para detalhes.`, 'error');
        }

        // ATUALIZAÇÃO AUTOMÁTICA: Atualizar datas do projeto se em modo automático
        dataService.updateProjectDatesIfAuto(project);

        dataService.recalculateAllProgress();
        await dataService.saveProjectDocument(project);
        return validTasks.length;
    },



    // Função auxiliar para converter datas do Excel
    parseExcelDate: function (excelDate) {
        if (!excelDate) return null;

        try {
            // Se for número (formato Excel)
            if (typeof excelDate === 'number') {
                const date = new Date((excelDate - 25569) * 86400 * 1000);
                return date.toISOString().split('T')[0];
            }

            // Se for string, tentar parse
            if (typeof excelDate === 'string') {
                // Remover espaços extras e tentar diferentes formatos
                const cleanDate = excelDate.trim();

                // Formato YYYY-MM-DD
                if (/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
                    return cleanDate;
                }

                // Formato DD/MM/YYYY
                if (/^\d{2}\/\d{2}\/\d{4}$/.test(cleanDate)) {
                    const parts = cleanDate.split('/');
                    return `${parts[2]}-${parts[1]}-${parts[0]}`;
                }

                // NOVO: Formato MS Project em português "01 Dezembro 2025 08:00" ou "01 Dezembro 2025"
                const portugueseMonths = {
                    'janeiro': '01', 'fevereiro': '02', 'março': '03', 'marco': '03',
                    'abril': '04', 'maio': '05', 'junho': '06',
                    'julho': '07', 'agosto': '08', 'setembro': '09',
                    'outubro': '10', 'novembro': '11', 'dezembro': '12'
                };

                // Regex para capturar "DD Mês YYYY" ou "DD Mês YYYY HH:MM"
                const ptDateRegex = /^(\d{1,2})\s+([a-zA-ZçÇ]+)\s+(\d{4})(?:\s+\d{2}:\d{2})?$/i;
                const ptMatch = cleanDate.match(ptDateRegex);

                if (ptMatch) {
                    const day = ptMatch[1].padStart(2, '0');
                    const monthName = ptMatch[2].toLowerCase();
                    const year = ptMatch[3];
                    const month = portugueseMonths[monthName];

                    if (month) {
                        return `${year}-${month}-${day}`;
                    }
                }

                // NOVO: Formato "Seg DD/MM/YY" ou similar com dia da semana
                const weekdayDateRegex = /^[a-zA-Z]{3}\s+(\d{2})\/(\d{2})\/(\d{2,4})$/i;
                const weekdayMatch = cleanDate.match(weekdayDateRegex);

                if (weekdayMatch) {
                    const day = weekdayMatch[1];
                    const month = weekdayMatch[2];
                    let year = weekdayMatch[3];
                    if (year.length === 2) {
                        year = '20' + year;
                    }
                    return `${year}-${month}-${day}`;
                }

                // Tentar parse automático
                const parsedDate = new Date(cleanDate);
                if (!isNaN(parsedDate.getTime())) {
                    return parsedDate.toISOString().split('T')[0];
                }
            }

            return null;
        } catch (error) {
            console.warn('Erro ao converter data:', excelDate, error);
            return null;
        }
    },


    // Função para encontrar IDs de usuário pelos nomes
    findUserIdsByNames: function (names) {
        return names.map(name => {
            const user = dataService.users.find(u =>
                u.name?.toLowerCase().includes(name.toLowerCase()) ||
                u.email.toLowerCase().includes(name.toLowerCase())
            );
            return user?.id || null;
        }).filter(id => id !== null);
    },

    // --- NOVO: SISTEMA DE NOTIFICAÇÕES ---

    // Função para escutar notificações do usuário atual
    listenToNotifications: function () {
        unsubscribeNotifications();
        if (!dataService.isAuthReady || !dataService.userId) return;

        const notificationsRef = collection(db, 'users_data', dataService.userId, 'notifications');

        unsubscribeNotifications = onSnapshot(notificationsRef, (snapshot) => {
            dataService.notifications = [];
            snapshot.forEach(doc => {
                dataService.notifications.push({ id: doc.id, ...doc.data() });
            });

            // Ordenar notificações por data (mais recentes primeiro)
            dataService.notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            // Atualizar a UI das notificações
            uiService.updateNotificationUI();
        }, (error) => {
            console.error("Erro ao ouvir notificações:", error);
        });
    },

    // Função para enviar notificações de atribuição de tarefas
    sendTaskAssignmentNotifications: async function (taskId, taskName, projectId, projectName, assignedUserIds) {
        try {
            const currentUser = dataService.users.find(u => u.id === dataService.userId);
            const currentUserName = currentUser?.name || currentUser?.email.split('@')[0] || 'Um utilizador';

            for (const userId of assignedUserIds) {
                // Não enviar notificação para o próprio usuário
                if (userId === dataService.userId) continue;

                const notification = {
                    type: 'task_assignment',
                    title: 'Nova tarefa atribuída',
                    message: `${currentUserName} atribuiu a tarefa "${taskName}" a você`,
                    projectId: projectId,
                    projectName: projectName,
                    taskId: taskId,
                    taskName: taskName,
                    read: false,
                    createdAt: new Date().toISOString(),
                    createdBy: dataService.userId
                };

                const userNotificationsRef = collection(db, 'users_data', userId, 'notifications');
                await addDoc(userNotificationsRef, notification);
            }

            console.log(`📨 Notificações de atribuição enviadas para ${assignedUserIds.length - (assignedUserIds.includes(dataService.userId) ? 1 : 0)} utilizadores`);
        } catch (error) {
            console.error("Erro ao enviar notificações:", error);
        }
    },

    // Função para marcar notificação como lida
    markNotificationAsRead: async function (notificationId) {
        try {
            const notificationRef = doc(db, 'users_data', dataService.userId, 'notifications', notificationId);
            await updateDoc(notificationRef, {
                read: true,
                readAt: new Date().toISOString()
            });
        } catch (error) {
            console.error("Erro ao marcar notificação como lida:", error);
        }
    },

    // Função para marcar todas as notificações como lidas
    markAllNotificationsAsRead: async function () {
        try {
            const unreadNotifications = dataService.notifications.filter(n => !n.read);

            for (const notification of unreadNotifications) {
                await dataService.markNotificationAsRead(notification.id);
            }

            uiService.showToast('Todas as notificações marcadas como lidas', 'success');
        } catch (error) {
            console.error("Erro ao marcar todas as notificações como lidas:", error);
            uiService.showToast('Erro ao marcar notificações como lidas', 'error');
        }
    },

    // Função para limpar todas as notificações
    clearAllNotifications: async function () {
        try {
            const notificationsRef = collection(db, 'users_data', dataService.userId, 'notifications');
            const snapshot = await getDocs(notificationsRef);

            const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
            await Promise.all(deletePromises);

            uiService.showToast('Todas as notificações foram removidas', 'success');
        } catch (error) {
            console.error("Erro ao limpar notificações:", error);
            uiService.showToast('Erro ao limpar notificações', 'error');
        }
    },

    // Função para obter o número de notificações não lidas
    getUnreadNotificationCount: function () {
        return dataService.notifications.filter(n => !n.read).length;
    },

    // --- NOVO: SISTEMA DE ANEXOS ---

    // Função para fazer upload de arquivo
    uploadAttachment: async function (file, taskId, projectId) {
        try {
            // Criar referência no Storage
            const storageRef = ref(storage, `projetos/${projectId}/${taskId}/${file.name}`);

            // Fazer upload do arquivo
            const snapshot = await uploadBytes(storageRef, file);

            // Obter URL de download
            const downloadURL = await getDownloadURL(snapshot.ref);

            return {
                name: file.name,
                url: downloadURL,
                size: file.size,
                type: file.type,
                uploadedAt: new Date().toISOString(),
                uploadedBy: dataService.userId
            };
        } catch (error) {
            console.error("Erro ao fazer upload do arquivo:", error);
            throw error;
        }
    },

    // Função para excluir anexo
    deleteAttachment: async function (fileName, taskId, projectId) {
        try {
            // Criar referência no Storage
            const storageRef = ref(storage, `projetos/${projectId}/${taskId}/${fileName}`);

            // Excluir arquivo
            await deleteObject(storageRef);

            return true;
        } catch (error) {
            console.error("Erro ao excluir arquivo:", error);
            throw error;
        }
    },

    // Função para obter ícone do arquivo baseado na extensão
    getFileIcon: function (fileName) {
        const extension = fileName.split('.').pop().toLowerCase();
        const iconMap = {
            'pdf': '📕',
            'doc': '📘',
            'docx': '📘',
            'xls': '📗',
            'xlsx': '📗',
            'ppt': '📙',
            'pptx': '📙',
            'jpg': '🖼️',
            'jpeg': '🖼️',
            'png': '🖼️',
            'gif': '🖼️',
            'zip': '📦',
            'rar': '📦',
            'txt': '📄',
            'csv': '📊'
        };

        return iconMap[extension] || '📎';
    },

    // --- NOVO: NOTIFICAÇÕES DE COMENTÁRIOS ---

    // Função para enviar notificações de comentários para responsáveis da tarefa
    sendCommentNotification: async function (taskId, taskName, projectId, projectName, commentText, assignedUserIds) {
        try {
            const currentUser = dataService.users.find(u => u.id === dataService.userId);
            const currentUserName = currentUser?.name || currentUser?.email.split('@')[0] || 'Um utilizador';

            for (const userId of assignedUserIds) {
                // Não enviar notificação para o próprio autor do comentário
                if (userId === dataService.userId) continue;

                const notification = {
                    type: 'comment',
                    title: 'Novo comentário na tarefa',
                    message: `${currentUserName} comentou na tarefa "${taskName}": "${commentText.substring(0, 80)}${commentText.length > 80 ? '...' : ''}"`,
                    projectId: projectId,
                    projectName: projectName,
                    taskId: taskId,
                    taskName: taskName,
                    read: false,
                    createdAt: new Date().toISOString(),
                    createdBy: dataService.userId
                };

                const userNotificationsRef = collection(db, 'users_data', userId, 'notifications');
                await addDoc(userNotificationsRef, notification);
            }

            console.log(`💬 Notificações de comentário enviadas para responsáveis`);
        } catch (error) {
            console.error("Erro ao enviar notificações de comentário:", error);
        }
    },

    // --- NOVO: SISTEMA DE MENÇÕES ---

    // Função para enviar notificação de menção
    sendMentionNotification: async function (mentionedUserId, taskId, taskName, projectId, projectName, commentText) {
        try {
            const currentUser = dataService.users.find(u => u.id === dataService.userId);
            const currentUserName = currentUser?.name || currentUser?.email.split('@')[0] || 'Um utilizador';

            const notification = {
                type: 'mention',
                title: 'Você foi mencionado',
                message: `${currentUserName} mencionou você em um comentário na tarefa "${taskName}": "${commentText.substring(0, 100)}${commentText.length > 100 ? '...' : ''}"`,
                projectId: projectId,
                projectName: projectName,
                taskId: taskId,
                taskName: taskName,
                read: false,
                createdAt: new Date().toISOString(),
                createdBy: dataService.userId
            };

            const userNotificationsRef = collection(db, 'users_data', mentionedUserId, 'notifications');
            await addDoc(userNotificationsRef, notification);

            console.log(`📨 Notificação de menção enviada para ${mentionedUserId}`);
        } catch (error) {
            console.error("Erro ao enviar notificação de menção:", error);
        }
    },

    // Função para processar menções em comentários
    processMentions: async function (commentText, taskId, taskName, projectId, projectName) {
        const mentionRegex = /@\[([^\]]+)\]\(([^)]+)\)/g;
        let match;
        const mentionedUserIds = [];

        while ((match = mentionRegex.exec(commentText)) !== null) {
            const userId = match[2];
            mentionedUserIds.push(userId);

            // Enviar notificação para o usuário mencionado
            await this.sendMentionNotification(userId, taskId, taskName, projectId, projectName, commentText);
        }

        return mentionedUserIds;
    },

    // --- NOVO: SISTEMA DE HISTÓRICO DE ATIVIDADE ---

    // Função para registrar atividade
    logActivity: async function (taskId, projectId, action, details, oldValue = null, newValue = null) {
        try {
            const currentUser = dataService.users.find(u => u.id === dataService.userId);
            const currentUserName = currentUser?.name || currentUser?.email.split('@')[0] || 'Um utilizador';

            const activity = {
                action: action,
                details: details,
                oldValue: oldValue,
                newValue: newValue,
                userId: dataService.userId,
                userName: currentUserName,
                timestamp: new Date().toISOString(),
                taskId: taskId,
                projectId: projectId
            };

            // Salvar atividade no Firestore (subcoleção da tarefa)
            const activityRef = collection(db, 'artifacts', appId, 'users', dataService.getProjectOwnerUid(projectId), 'projects', projectId, 'tasks', taskId.toString(), 'activity');
            await addDoc(activityRef, activity);

            console.log(`📝 Atividade registrada: ${action} para tarefa ${taskId}`);
        } catch (error) {
            console.error("Erro ao registrar atividade:", error);
        }
    },

    // Função para obter histórico de atividade
    getActivityHistory: async function (taskId, projectId) {
        try {
            const activityRef = collection(db, 'artifacts', appId, 'users', dataService.getProjectOwnerUid(projectId), 'projects', projectId, 'tasks', taskId.toString(), 'activity');
            const snapshot = await getDocs(activityRef);

            const activities = [];
            snapshot.forEach(doc => {
                activities.push({ id: doc.id, ...doc.data() });
            });

            // Ordenar por data (mais recente primeiro)
            activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            return activities;
        } catch (error) {
            console.error("Erro ao obter histórico de atividade:", error);
            return [];
        }
    }
};

// App Controller
const App = {
    async init() {
        document.getElementById('loader').style.display = 'flex';
        await dataService.initFirebase();
        uiService.initTheme();
        this.bindEvents();
    },

    async logout() {
        document.getElementById('loader').style.display = 'flex';
        await signOut(auth);
        document.getElementById('loader').style.display = 'none';
        uiService.showToast('Sessão encerrada com sucesso.', 'success');
    },

    showProjectView() {
        dataService.currentProjectId = null;
        uiService.showView('project-view');
        uiService.updateProjectTabCounts();
        const filteredProjects = uiService.getFilteredProjects();
        uiService.renderProjectList(filteredProjects);
        uiService.updateMainDashboard(dataService.projects.filter(p => !p.finalized));
    },

    openProject(projectId) {
        dataService.currentProjectId = projectId;
        const project = dataService.getProjectById(dataService.currentProjectId);
        if (project) {
            uiService.showView('dashboard-view');
            uiService.renderProjectDashboard(project);
        }
    },

    bindEvents() {
        document.getElementById('theme-toggle').addEventListener('click', () => uiService.toggleTheme());
        document.getElementById('logout-btn').addEventListener('click', () => App.logout());
        document.getElementById('user-management-btn').addEventListener('click', () => uiService.openUserManagementModal());

        // NOVO: Event listener para gestão de setores (Admin)
        document.getElementById('sector-management-btn')?.addEventListener('click', () => {
            uiService.renderSectorManagementTable();
            uiService.openModal('sector-management-modal');
        });

        // NOVO: Event listener para adicionar novo setor
        document.getElementById('add-sector-btn')?.addEventListener('click', () => {
            uiService.openSectorFormModal();
        });

        // NOVO: Event listener para formulário de setor
        document.getElementById('sector-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const sectorId = document.getElementById('sector-id').value;
            const sectorData = {
                name: document.getElementById('sector-name').value.trim(),
                description: document.getElementById('sector-description').value.trim()
            };

            if (!sectorData.name) {
                uiService.showToast('Nome do setor é obrigatório.', 'error');
                return;
            }

            try {
                if (sectorId) {
                    await dataService.updateSector(sectorId, sectorData);
                } else {
                    await dataService.addSector(sectorData);
                }
                uiService.closeModal('sector-form-modal');
            } catch (error) {
                console.error('Erro ao salvar setor:', error);
            }
        });

        // NOVO: Event listeners para o sistema de notificações
        document.getElementById('notification-btn').addEventListener('click', () => uiService.toggleNotificationDropdown());
        document.getElementById('mark-all-read-btn').addEventListener('click', () => dataService.markAllNotificationsAsRead());
        document.getElementById('clear-notifications-btn').addEventListener('click', () => dataService.clearAllNotifications());

        // CORREÇÃO: Fechar modal de gestão antes de abrir cadastro
        document.getElementById('add-user-btn').addEventListener('click', () => {
            uiService.closeModal('user-management-modal');
            setTimeout(() => {
                uiService.openAddUserModal();
            }, 300);
        });

        // --- CORREÇÕES ADICIONADAS ---
        // CORREÇÃO 1: Botões de fechar funcionais para todos os modais
        document.querySelectorAll('.cancel-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modal = e.target.closest('.modal-transition');
                if (modal) {
                    uiService.closeModal(modal.id);
                }
            });
        });

        // CORREÇÃO 2: Fechar modal de gestão de usuários
        document.querySelector('#user-management-modal .cancel-btn').addEventListener('click', () => {
            uiService.closeModal('user-management-modal');
        });

        // CORREÇÃO 3: Fechar modal de adicionar usuário
        document.querySelector('#add-user-modal .cancel-btn').addEventListener('click', () => {
            uiService.closeModal('add-user-modal');
        });

        // CORREÇÃO 4: Fechar modal de projeto
        document.querySelector('#project-modal .cancel-btn').addEventListener('click', () => {
            uiService.closeModal('project-modal');
        });

        // CORREÇÃO 5: Fechar modal de datas do projeto
        document.querySelector('#project-date-modal .cancel-btn').addEventListener('click', () => {
            uiService.closeModal('project-date-modal');
        });

        // Event listeners para o modal de edição de utilizador
        document.querySelector('#edit-user-modal .cancel-btn').addEventListener('click', () => {
            uiService.closeModal('edit-user-modal');
        });

        document.getElementById('edit-user-form').addEventListener('submit', (e) => {
            e.preventDefault();
            uiService.saveEditUser();
        });

        document.getElementById('edit-user-active').addEventListener('change', (e) => {
            const statusLabel = document.getElementById('edit-user-status-label');
            if (e.target.checked) {
                statusLabel.textContent = 'Ativo';
                statusLabel.className = 'user-status-label active';
            } else {
                statusLabel.textContent = 'Inativo';
                statusLabel.className = 'user-status-label inactive';
            }
        });

        // --- AUTENTICAÇÃO ---
        const authForm = document.getElementById('auth-form');
        const authEmail = document.getElementById('auth-email');
        const authPassword = document.getElementById('auth-password');
        const authSubmitBtn = document.getElementById('auth-submit-btn');
        let isLoginMode = true;

        document.getElementById('toggle-auth-mode').addEventListener('click', (e) => {
            isLoginMode = !isLoginMode;
            authSubmitBtn.textContent = isLoginMode ? 'Login' : 'Registrar';
            e.target.textContent = isLoginMode ? 'Precisa de uma conta? Registrar' : 'Já tenho conta. Login';
        });

        // Esqueci minha senha
        document.getElementById('forgot-password-btn').addEventListener('click', async () => {
            const email = authEmail.value.trim();

            if (!email) {
                uiService.showToast('Digite seu e-mail para recuperar a senha.', 'error');
                authEmail.focus();
                return;
            }

            if (!email.endsWith(ALLOWED_DOMAIN)) {
                uiService.showToast(`E-mail deve terminar com ${ALLOWED_DOMAIN}`, 'error');
                return;
            }

            document.getElementById('loader').style.display = 'flex';
            try {
                await sendPasswordResetEmail(auth, email);
                uiService.showToast(`Email de redefinição enviado para ${email}. Verifique sua caixa de entrada.`, 'success');
            } catch (error) {
                console.error('Erro ao enviar email de redefinição:', error);
                if (error.code === 'auth/user-not-found') {
                    uiService.showToast('E-mail não encontrado no sistema.', 'error');
                } else {
                    uiService.showToast('Erro ao enviar email de redefinição. Tente novamente.', 'error');
                }
            } finally {
                document.getElementById('loader').style.display = 'none';
            }
        });

        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = authEmail.value;
            const password = authPassword.value;

            if (!email.endsWith(ALLOWED_DOMAIN)) {
                uiService.showToast(`E-mail inválido. Use o domínio ${ALLOWED_DOMAIN}.`, 'error');
                return;
            }

            document.getElementById('loader').style.display = 'flex';
            try {
                let userCredential;
                if (isLoginMode) {
                    userCredential = await signInWithEmailAndPassword(auth, email, password);
                } else {
                    userCredential = await createUserWithEmailAndPassword(auth, email, password);
                    await setDoc(doc(db, 'users_data', userCredential.user.uid), {
                        email: email,
                        role: 'Usuario',
                        appId: appId
                    });
                }
            } catch (error) {
                let errorMessage = error.message;
                if (error.code === 'auth/email-already-in-use') errorMessage = 'Este e-mail já está em uso.';
                if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') errorMessage = 'Credenciais inválidas.';
                if (error.code === 'auth/weak-password') errorMessage = 'A senha deve ter pelo menos 6 caracteres.';
                uiService.showToast(`Erro de Autenticação: ${errorMessage}`, 'error');
                document.getElementById('loader').style.display = 'none';
            }
        });
        // --- FIM AUTENTICAÇÃO ---

        // --- CADASTRO DE USUÁRIOS ---
        document.getElementById('add-user-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            const name = document.getElementById('new-user-name').value.trim();
            const email = document.getElementById('new-user-email').value.trim();
            const role = document.getElementById('new-user-role').value;

            if (!email) {
                uiService.showToast('Preencha o e-mail.', 'error');
                return;
            }

            if (!email.endsWith(ALLOWED_DOMAIN)) {
                uiService.showToast(`E-mail deve terminar com ${ALLOWED_DOMAIN}`, 'error');
                return;
            }

            document.getElementById('loader').style.display = 'flex';
            try {
                await dataService.createUserByGestor({ name, email, role });
                uiService.closeModal('add-user-modal');
                uiService.showToast('Usuário cadastrado com sucesso! Email de boas-vindas enviado.', 'success');
                document.getElementById('add-user-form').reset();

                // Reabrir modal de gestão após cadastro
                setTimeout(() => {
                    uiService.openUserManagementModal();
                }, 500);

            } catch (error) {
                console.error('Erro ao cadastrar usuário:', error);
                uiService.showToast(`Erro ao cadastrar usuário: ${error.message}`, 'error');
            } finally {
                document.getElementById('loader').style.display = 'none';
            }
        });

        // MELHORIA 02: Preencher automaticamente o nome do e-mail
        document.getElementById('new-user-email').addEventListener('blur', function () {
            const email = this.value.trim();
            const nameInput = document.getElementById('new-user-name');

            if (email && email.endsWith(ALLOWED_DOMAIN) && (!nameInput.value || nameInput.value === '')) {
                const nameFromEmail = email.split('@')[0];
                // Capitalizar primeira letra
                const capitalizedName = nameFromEmail.charAt(0).toUpperCase() + nameFromEmail.slice(1);
                nameInput.value = capitalizedName;
            }
        });

        // Event listener para fechar modal de alertas
        document.getElementById('alerts-close-btn').addEventListener('click', () => {
            uiService.closeModal('alerts-modal');
        });

        document.getElementById('add-project-btn').addEventListener('click', () => {
            uiService.populateProjectManagerSelect(); // NOVA LINHA - Popula o select de responsáveis
            uiService.openModal('project-modal');
        });

        document.getElementById('project-form').addEventListener('submit', event => {
            event.preventDefault();
            const name = document.getElementById('project-name').value.trim();
            const manager = document.getElementById('project-manager').value;
            const startDate = document.getElementById('project-start-date').value; // NOVO: Data de início
            const endDate = document.getElementById('project-end-date').value;     // NOVO: Data de término
            const sectorId = document.getElementById('project-sector')?.value || null; // NOVO: Setor

            if (name && manager && startDate && endDate) {
                if (new Date(startDate) > new Date(endDate)) {
                    uiService.showToast('Data de início não pode ser posterior à data de término!', 'error');
                    return;
                }

                dataService.addProject({ name, manager, startDate, endDate, sectorId });
                uiService.closeModal('project-modal');
                uiService.showToast('Projeto criado com sucesso! Sincronizando...', 'success');
            } else {
                uiService.showToast('Preencha todos os campos obrigatórios.', 'error');
            }
        });

        // NOVO: Event listener para edição de datas do projeto
        document.getElementById('edit-project-dates-btn').addEventListener('click', () => {
            uiService.openProjectDateModal();
        });

        // Event listener para finalizar projeto
        document.getElementById('finalize-project-btn').addEventListener('click', async () => {
            const project = dataService.getProjectById(dataService.currentProjectId);
            if (!project) return;

            const confirmed = await uiService.showConfirmModalPromise(
                `Tem certeza que deseja finalizar o projeto "${project.name}"? O projeto será movido para a aba de Projetos Finalizados.`,
                'Finalizar Projeto'
            );

            if (confirmed) {
                await dataService.finalizeProject(dataService.currentProjectId);
                uiService.showToast('Projeto finalizado com sucesso!', 'success');
                App.showProjectView();
            }
        });

        // Event listener para reabrir projeto
        document.getElementById('reopen-project-btn').addEventListener('click', async () => {
            const project = dataService.getProjectById(dataService.currentProjectId);
            if (!project) return;

            const confirmed = await uiService.showConfirmModalPromise(
                `Tem certeza que deseja reabrir o projeto "${project.name}"? O projeto voltará para a aba de Projetos Ativos.`,
                'Reabrir Projeto'
            );

            if (confirmed) {
                await dataService.reopenProject(dataService.currentProjectId);
                uiService.showToast('Projeto reaberto com sucesso!', 'success');
                App.showProjectView();
            }
        });

        // NOVO: Event listener para formulário de edição de datas do projeto
        document.getElementById('project-date-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            const projectId = document.getElementById('edit-project-id').value;
            const projectName = document.getElementById('edit-project-name').value;
            const startDate = document.getElementById('edit-project-start-date').value;
            const endDate = document.getElementById('edit-project-end-date').value;

            if (!projectName || !startDate || !endDate) {
                uiService.showToast('Preencha todos os campos.', 'error');
                return;
            }

            if (new Date(startDate) > new Date(endDate)) {
                uiService.showToast('Data de início não pode ser posterior à data de término!', 'error');
                return;
            }

            document.getElementById('loader').style.display = 'flex';
            try {
                const project = dataService.getProjectById(projectId);
                if (project) {
                    project.name = projectName;
                    project.startDate = startDate;
                    project.endDate = endDate;
                    project.dateMode = 'manual';
                    await dataService.saveProjectDocument(project);
                    uiService.closeModal('project-date-modal');
                    uiService.showToast('Projeto atualizado com sucesso!', 'success');
                }
            } catch (error) {
                console.error('Erro ao atualizar projeto:', error);
                uiService.showToast('Erro ao atualizar projeto.', 'error');
            } finally {
                document.getElementById('loader').style.display = 'none';
            }
        });

        document.getElementById('project-list').addEventListener('click', event => {
            const deleteBtn = event.target.closest('.delete-project-btn');

            if (deleteBtn) {
                event.stopPropagation();
                const projectId = deleteBtn.dataset.projectId;
                uiService.showConfirmModal('Excluir este projeto e todas as suas tarefas? Esta ação é permanente.', async () => {
                    document.getElementById('loader').style.display = 'flex';
                    await dataService.deleteProject(projectId);
                    document.getElementById('loader').style.display = 'none';
                    uiService.showToast('Projeto excluído. Sincronizando...', 'error');
                });
                return;
            }

            const card = event.target.closest('.project-card-link');
            if (card) {
                this.openProject(card.dataset.projectId);
            }
        });

        document.getElementById('back-to-projects-btn').addEventListener('click', () => this.showProjectView());
        document.getElementById('add-task-btn').addEventListener('click', () => uiService.openTaskModal('add'));

        // Event listeners para novas funcionalidades do modal de tarefa
        document.getElementById('user-search-input').addEventListener('input', (e) => {
            uiService.filterUserCheckboxes(e.target.value);
        });

        document.getElementById('same-day-btn').addEventListener('click', () => {
            const startDate = document.getElementById('start-date').value;
            if (startDate) {
                document.getElementById('end-date').value = startDate;
            } else {
                uiService.showToast('Preencha a data de início primeiro', 'error');
            }
        });

        document.getElementById('today-btn').addEventListener('click', () => {
            const today = new Date().toISOString().split('T')[0];
            document.getElementById('start-date').value = today;
            document.getElementById('end-date').value = today;
        });

        // Quando a data de início muda, ajustar a data de término se necessário
        document.getElementById('start-date').addEventListener('change', (e) => {
            const endDate = document.getElementById('end-date').value;
            if (!endDate || new Date(endDate) < new Date(e.target.value)) {
                document.getElementById('end-date').value = e.target.value;
            }
        });

        document.getElementById('task-form').addEventListener('submit', async event => {
            event.preventDefault();
            const taskData = uiService.getTaskFormData();

            // Validação básica de datas
            if (new Date(taskData.newStartDate) > new Date(taskData.newEndDate)) {
                uiService.showToast('Data de Início não pode ser posterior à Data de Término!', 'error');
                return;
            }

            // MELHORIA 01: Validação adicional para subtarefas
            if (taskData.parentId) {
                const project = dataService.getCurrentProject();
                const parentTask = project.tasks.find(t => t.id === taskData.parentId);
                if (parentTask) {
                    const parentDates = dataService.getLatestDates(parentTask);
                    const parentStart = new Date(parentDates.startDate);
                    const childStart = new Date(taskData.newStartDate);

                    if (childStart < parentStart) {
                        uiService.showToast('A subtarefa não pode começar antes da tarefa pai!', 'error');
                        return;
                    }
                }
            }

            document.getElementById('loader').style.display = 'flex';
            await dataService.saveTask(taskData);
            document.getElementById('loader').style.display = 'none';

            uiService.closeModal('task-modal');
            uiService.showToast('Tarefa salva! Sincronizando...');
        });

        document.getElementById('add-comment-btn').addEventListener('click', () => {
            const input = document.getElementById('new-comment-input');
            const text = input.value.trim();
            if (text) {
                uiService.addComment(text);
                input.value = '';
            }
        });

        document.getElementById('new-comment-input').addEventListener('keypress', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                document.getElementById('add-comment-btn').click();
            }
        });


        document.getElementById('task-table-body').addEventListener('click', event => {
            const button = event.target.closest('button');
            const taskNameEl = event.target.closest('.task-edit-trigger');

            if (taskNameEl) {
                const taskId = parseFloat(taskNameEl.dataset.taskId); // CORREÇÃO: Usar parseFloat para IDs com decimais
                uiService.openTaskModal('edit', { taskId });
                return;
            }

            if (!button) return;
            const taskId = parseFloat(button.dataset.taskId); // CORREÇÃO: Usar parseFloat para IDs com decimais
            const parentId = parseFloat(button.dataset.parentId);

            if (button.classList.contains('add-subtask-btn')) uiService.openTaskModal('add', { parentId });
            if (button.classList.contains('edit-task-btn')) uiService.openTaskModal('edit', { taskId });

            if (button.classList.contains('delete-task-btn')) {
                uiService.showConfirmModal('Excluir esta tarefa e suas subtarefas?', async () => {
                    document.getElementById('loader').style.display = 'flex';
                    await dataService.deleteTask(taskId);
                    document.getElementById('loader').style.display = 'none';
                    uiService.showToast('Tarefa excluída. Sincronizando...', 'error');
                });
            }
        });

        document.getElementById('task-filter-input').addEventListener('input', (e) => {
            uiService.renderProjectDashboard(dataService.getCurrentProject(), e.target.value);
        });

        document.getElementById('view-switcher').addEventListener('change', (e) => uiService.switchView(e.target.value));
        document.getElementById('export-excel-btn').addEventListener('click', () => reportService.exportExcel(dataService.getCurrentProject()));
        document.getElementById('export-msproject-btn').addEventListener('click', () => reportService.exportMSProject(dataService.getCurrentProject()));
        document.getElementById('generate-pdf-report-btn').addEventListener('click', () => reportService.generatePdf(dataService.getCurrentProject()));
        document.getElementById('print-view-btn').addEventListener('click', () => window.print());
        document.getElementById('download-template-btn').addEventListener('click', () => reportService.downloadExcelTemplate());
        document.getElementById('import-excel-btn').addEventListener('click', () => document.getElementById('import-excel-input').click());

        // NOVO: Event listener para importação do MS Project
        document.getElementById('import-msproject-btn').addEventListener('click', () => document.getElementById('import-msproject-input').click());

        // NOVO: Evento de importação do MS Project
        document.getElementById('import-msproject-input').addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (file) {
                document.getElementById('loader').style.display = 'flex';
                try {
                    const result = await dataService.processMSProjectImport(file);

                    if (!result.needsAdjustment) {
                        uiService.showToast(`MS Project: ${result.count} tarefas importadas com sucesso!`, 'success');
                    }
                } catch (error) {
                    console.error('Erro na importação do MS Project:', error);
                    uiService.showToast('Erro ao importar arquivo do MS Project: ' + error.message, 'error');
                } finally {
                    document.getElementById('loader').style.display = 'none';
                    event.target.value = '';
                }
            }
        });

        // NOVO: Event listener para importação do Excel Antigo (Tecsidel)
        document.getElementById('import-legacy-btn').addEventListener('click', () => document.getElementById('import-legacy-input').click());

        // NOVO: Evento de importação do Excel Antigo
        document.getElementById('import-legacy-input').addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (file) {
                document.getElementById('loader').style.display = 'flex';
                try {
                    const result = await dataService.processLegacyExcelImport(file);

                    if (!result.needsAdjustment) {
                        uiService.showToast(`Excel Antigo: ${result.count} tarefas importadas com sucesso!`, 'success');
                    }
                } catch (error) {
                    console.error('Erro na importação do Excel Antigo:', error);
                    uiService.showToast('Erro ao importar arquivo Excel Antigo: ' + error.message, 'error');
                } finally {
                    document.getElementById('loader').style.display = 'none';
                    event.target.value = '';
                }
            }
        });

        // ATUALIZADO: Evento de importação com nova funcionalidade
        document.getElementById('import-excel-input').addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (file) {
                document.getElementById('loader').style.display = 'flex';
                try {
                    // Usar a nova função de importação com validação
                    const result = await dataService.processImportWithValidation(file);

                    if (!result.needsAdjustment) {
                        uiService.showToast(`${result.count} tarefas importadas com sucesso!`, 'success');
                    }
                    // Se needsAdjustment = true, o modal de ajustes já foi aberto automaticamente

                } catch (error) {
                    console.error('Erro na importação:', error);

                    // Mensagens de erro mais específicas
                    let errorMessage = 'Erro ao importar arquivo. ';

                    if (error.message.includes('vazia')) {
                        errorMessage += 'A planilha está vazia.';
                    } else if (error.message.includes('formato')) {
                        errorMessage += 'Formato de arquivo inválido. Use .xlsx ou .xls.';
                    } else if (error.message.includes('projeto')) {
                        errorMessage += 'Nenhum projeto selecionado.';
                    } else {
                        errorMessage += `Detalhes: ${error.message}`;
                    }

                    uiService.showToast(errorMessage, 'error');
                } finally {
                    document.getElementById('loader').style.display = 'none';
                    event.target.value = '';
                }
            }
        });

        // NOVO: Event listeners para o modal de confirmação de datas de subtarefas
        document.getElementById('subtask-date-cancel-btn').addEventListener('click', () => {
            uiService.closeModal('subtask-date-confirm-modal');
            uiService.subtaskDateConfirmResolve(false);
        });

        document.getElementById('subtask-date-confirm-btn').addEventListener('click', () => {
            const updateParent = document.getElementById('update-parent-dates').checked;
            uiService.closeModal('subtask-date-confirm-modal');
            uiService.subtaskDateConfirmResolve(updateParent);
        });

        // NOVO: Event listeners para os botões de visualização Cards/Lista
        document.getElementById('view-cards-btn').addEventListener('click', () => {
            uiService.switchProjectView('cards');
        });

        document.getElementById('view-list-btn').addEventListener('click', () => {
            uiService.switchProjectView('list');
        });

        // Event listeners para abas de projetos ativos/finalizados
        document.getElementById('tab-active-projects').addEventListener('click', () => {
            uiService.switchProjectTab('active');
        });

        document.getElementById('tab-finalized-projects').addEventListener('click', () => {
            uiService.switchProjectTab('finalized');
        });

        // NOVO: Sincronizar range com input numérico de progresso
        document.getElementById('task-progress-range').addEventListener('input', function () {
            document.getElementById('task-progress').value = this.value;
        });

        document.getElementById('task-progress').addEventListener('input', function () {
            document.getElementById('task-progress-range').value = this.value;
        });

        // NOVO: Event listeners para abas de comentários/atividade
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                uiService.switchTab(tabName);
            });
        });

        // NOVO: Event listeners para sistema de anexos
        document.getElementById('upload-area').addEventListener('click', () => {
            document.getElementById('file-upload').click();
        });

        document.getElementById('file-upload').addEventListener('change', (event) => {
            uiService.handleFileUpload(event.target.files);
        });

        // NOVO: Drag and drop para área de upload
        const uploadArea = document.getElementById('upload-area');
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            uiService.handleFileUpload(e.dataTransfer.files);
        });

        // NOVO: Event listener para menções
        document.getElementById('new-comment-input').addEventListener('input', (e) => {
            uiService.handleMentionInput(e);
        });

        document.getElementById('new-comment-input').addEventListener('keydown', (e) => {
            uiService.handleMentionKeydown(e);
        });
    }
};

// UI Service - Manages all DOM interactions
const uiService = {
    mainDashboardCharts: {},
    editingCommentId: null, // Para controle de edição de comentários
    subtaskDateConfirmResolve: null, // Para resolver a Promise do modal de confirmação
    notificationDropdownVisible: false, // NOVO: Controla visibilidade do dropdown de notificações
    mentionSuggestionsVisible: false, // NOVO: Controla visibilidade das sugestões de menção
    currentMentionStart: -1, // NOVO: Posição inicial da menção atual
    mentionedUsers: [], // NOVO: Usuários mencionados no comentário atual

    // Função para formatar menções para exibição
    formatMentionsForDisplay: function (text) {
        if (!text) return '';
        // Regex para capturar @[Nome](ID) e substituir por @Nome destacado
        const regex = new RegExp('@\\[([^\\]]+)\\]\\([^)]+\\)', 'g');
        return text.replace(regex, '<span class="mention-highlight">@$1</span>');
    },

    // --- AUTH UI ---
    updateUserRoleDisplay: () => {
        const roleEl = document.getElementById('user-role-display');
        const userBtn = document.getElementById('user-management-btn');
        const sectorBtn = document.getElementById('sector-management-btn');
        const reportsBtn = document.getElementById('reports-btn-container'); // NOVO: Botão de relatórios

        if (dataService.userRole) {
            const role = dataService.userRole.toLowerCase();
            roleEl.textContent = `Papel: ${dataService.userRole}`;

            // Resetar classes
            roleEl.classList.remove(
                'bg-blue-100', 'dark:bg-blue-900', 'text-blue-700', 'dark:text-blue-300',
                'bg-green-100', 'dark:bg-green-900', 'text-green-700', 'dark:text-green-300',
                'bg-purple-100', 'dark:bg-purple-900', 'text-purple-700', 'dark:text-purple-300'
            );

            if (role === 'admin') {
                // Admin: badge roxo, vê botão de setores, usuários e relatórios
                roleEl.classList.add('bg-purple-100', 'dark:bg-purple-900', 'text-purple-700', 'dark:text-purple-300');
                sectorBtn?.classList.remove('hidden');
                userBtn?.classList.remove('hidden');
                if (reportsBtn) {
                    reportsBtn.classList.remove('hidden');
                    console.log('Reports button shown for admin');
                }
            } else if (role === 'gestor') {
                // Gestor: badge verde, vê botão de usuários e relatórios
                roleEl.classList.add('bg-green-100', 'dark:bg-green-900', 'text-green-700', 'dark:text-green-300');
                sectorBtn?.classList.add('hidden');
                userBtn?.classList.remove('hidden');
                if (reportsBtn) {
                    reportsBtn.classList.remove('hidden');
                    console.log('Reports button shown for gestor');
                }
            } else {
                // Usuário comum: badge azul, não vê botões de gestão
                roleEl.classList.add('bg-blue-100', 'dark:bg-blue-900', 'text-blue-700', 'dark:text-blue-300');
                sectorBtn?.classList.add('hidden');
                userBtn?.classList.add('hidden');
                reportsBtn?.classList.add('hidden'); // NOVO: Esconder relatórios de usuários comuns
            }
        }
    },

    // --- USER MANAGEMENT UI (Gestor/Admin) ---
    openUserManagementModal: () => {
        const role = dataService.userRole?.toLowerCase();
        if (role !== 'gestor' && role !== 'admin') {
            uiService.showToast('Acesso negado: Apenas Gestores e Admins podem gerir utilizadores.', 'error');
            return;
        }
        uiService.renderUserManagementTable();
        uiService.openModal('user-management-modal');
    },

    openAddUserModal: () => {
        const role = dataService.userRole?.toLowerCase();
        if (role !== 'gestor' && role !== 'admin') {
            uiService.showToast('Acesso negado: Apenas Gestores e Admins podem cadastrar usuários.', 'error');
            return;
        }
        document.getElementById('add-user-form').reset();

        // Mostrar opção Admin se usuário atual for Admin
        const adminOption = document.getElementById('new-user-role-admin-option');
        if (role === 'admin') {
            adminOption?.classList.remove('hidden');
        } else {
            adminOption?.classList.add('hidden');
        }

        uiService.openModal('add-user-modal');
    },

    // NOVA FUNÇÃO: Abrir modal de edição de datas do projeto
    openProjectDateModal: function () {
        const project = dataService.getCurrentProject();
        if (!project) return;

        document.getElementById('edit-project-id').value = project.id;
        document.getElementById('edit-project-name').value = project.name || '';
        document.getElementById('edit-project-start-date').value = project.startDate;
        document.getElementById('edit-project-end-date').value = project.endDate;

        // Verificar se o projeto tem subtarefas para determinar se pode editar manualmente
        const hasSubtasks = dataService.projectHasSubtasks(project);

        if (hasSubtasks && project.dateMode === 'auto') {
            document.getElementById('edit-project-start-date').disabled = true;
            document.getElementById('edit-project-end-date').disabled = true;
            uiService.showToast('As datas do projeto são automáticas devido às subtarefas existentes.', 'info');
        } else {
            document.getElementById('edit-project-start-date').disabled = false;
            document.getElementById('edit-project-end-date').disabled = false;
        }

        this.openModal('project-date-modal');
    },

    renderUserManagementTable: () => {
        const tbody = document.getElementById('user-management-table-body');
        tbody.innerHTML = '';

        const currentUserRole = dataService.userRole?.toLowerCase();
        const isAdmin = currentUserRole === 'admin';

        dataService.users.forEach(user => {
            const row = document.createElement('tr');
            const isActive = user.active !== false;
            row.className = `border-b border-[var(--border-color)] ${!isActive ? 'user-row-inactive' : ''}`;

            // Admin pode ver e atribuir todas as roles, Gestor só vê Usuario e Gestor
            const availableRoles = isAdmin ? ['Usuario', 'Gestor', 'admin'] : ['Usuario', 'Gestor'];
            const roleOptions = availableRoles.map(role =>
                `<option value="${role}" ${user.role?.toLowerCase() === role.toLowerCase() ? 'selected' : ''}>${role}</option>`
            ).join('');

            const isSelf = user.id === dataService.userId;
            // Admin pode editar qualquer usuário (exceto a si mesmo para mudar role)
            const isDisabled = isSelf ? 'disabled' : '';

            // Determinar a cor do badge baseado no role
            const userRole = user.role?.toLowerCase() || 'usuario';
            const badgeClass = userRole === 'admin' ? 'bg-purple-600 text-white' :
                userRole === 'gestor' ? 'bg-green-600 text-white' : 'bg-blue-600 text-white';

            row.innerHTML = `
                <td class="p-3 font-medium">${user.name || 'Não informado'}</td>
                <td class="p-3">${user.email}</td>
                <td class="p-3">
                    <span class="px-2 py-1 rounded-full text-xs ${badgeClass}">
                        ${user.role || 'Usuario'}
                    </span>
                </td>
                <td class="p-3">
                    <div class="flex items-center">
                        <label class="user-status-toggle">
                            <input type="checkbox" data-user-id="${user.id}" class="user-status-checkbox" ${isActive ? 'checked' : ''} ${isDisabled}>
                            <span class="user-status-slider"></span>
                        </label>
                        <span class="user-status-label ${isActive ? 'active' : 'inactive'}">${isActive ? 'Ativo' : 'Inativo'}</span>
                    </div>
                </td>
                <td class="p-3 text-center">
                    <div class="flex justify-center gap-2">
                        <button data-user-id="${user.id}" class="edit-user-btn bg-blue-500 text-white px-3 py-1 rounded-md text-xs hover:bg-blue-600 ${isDisabled ? 'opacity-50 cursor-not-allowed' : ''}" ${isDisabled} title="Editar utilizador">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 inline" viewBox="0 0 20 20" fill="currentColor">
                                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                            </svg>
                            Editar
                        </button>
                        <button data-user-email="${user.email}" class="reset-password-btn bg-orange-500 text-white px-3 py-1 rounded-md text-xs hover:bg-orange-600" title="Redefinir senha">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 inline" viewBox="0 0 20 20" fill="currentColor">
                                <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                            </svg>
                            Senha
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(row);
        });

        tbody.querySelectorAll('.edit-user-btn').forEach(btn => {
            if (!btn.disabled) {
                btn.addEventListener('click', () => {
                    const uid = btn.dataset.userId;
                    uiService.openEditUserModal(uid);
                });
            }
        });

        tbody.querySelectorAll('.user-status-checkbox').forEach(checkbox => {
            if (!checkbox.disabled) {
                checkbox.addEventListener('change', async (e) => {
                    const uid = checkbox.dataset.userId;
                    const isActive = e.target.checked;
                    await uiService.toggleUserStatus(uid, isActive);
                });
            }
        });

        tbody.querySelectorAll('.reset-password-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const email = btn.dataset.userEmail;
                uiService.showConfirmModal(`Enviar email de redefinição de senha para ${email}?`, async () => {
                    document.getElementById('loader').style.display = 'flex';
                    await dataService.resetUserPassword(email);
                    document.getElementById('loader').style.display = 'none';
                });
            });
        });
    },

    openEditUserModal: (userId) => {
        const role = dataService.userRole?.toLowerCase();
        if (role !== 'gestor' && role !== 'admin') {
            uiService.showToast('Acesso negado: Apenas Gestores e Admins podem editar utilizadores.', 'error');
            return;
        }
        const user = dataService.users.find(u => u.id === userId);
        if (!user) {
            uiService.showToast('Utilizador não encontrado.', 'error');
            return;
        }
        document.getElementById('edit-user-id').value = user.id;
        document.getElementById('edit-user-name').value = user.name || '';
        document.getElementById('edit-user-email').value = user.email || '';

        // Mostrar opção Admin se usuário atual for Admin
        const adminOption = document.getElementById('edit-user-role-admin-option');
        if (role === 'admin') {
            adminOption?.classList.remove('hidden');
        } else {
            adminOption?.classList.add('hidden');
        }

        document.getElementById('edit-user-role').value = user.role || 'Usuario';

        // NOVO: Carregar setores no dropdown
        const sectorSelect = document.getElementById('edit-user-sector');
        sectorSelect.innerHTML = '<option value="">Nenhum setor</option>';
        dataService.sectors.forEach(sector => {
            const option = document.createElement('option');
            option.value = sector.id;
            option.textContent = sector.name;
            if (user.sectorId === sector.id) {
                option.selected = true;
            }
            sectorSelect.appendChild(option);
        });

        const isActive = user.active !== false;
        document.getElementById('edit-user-active').checked = isActive;
        const statusLabel = document.getElementById('edit-user-status-label');
        statusLabel.textContent = isActive ? 'Ativo' : 'Inativo';
        statusLabel.className = `user-status-label ${isActive ? 'active' : 'inactive'}`;
        uiService.openModal('edit-user-modal');
    },

    saveEditUser: async () => {
        const userId = document.getElementById('edit-user-id').value;
        const name = document.getElementById('edit-user-name').value.trim();
        const email = document.getElementById('edit-user-email').value.trim();
        const role = document.getElementById('edit-user-role').value;
        const active = document.getElementById('edit-user-active').checked;
        const sectorId = document.getElementById('edit-user-sector').value || null; // NOVO: Capturar setor

        if (!email.endsWith('@vinci-highways.com.br')) {
            uiService.showToast('O e-mail deve terminar com @vinci-highways.com.br', 'error');
            return;
        }

        document.getElementById('loader').style.display = 'flex';
        try {
            await dataService.updateUser(userId, { name, email, role, active, sectorId }); // NOVO: Salvar setor
            uiService.showToast('Utilizador atualizado com sucesso!', 'success');
            uiService.closeModal('edit-user-modal');
            uiService.renderUserManagementTable();
        } catch (error) {
            uiService.showToast('Erro ao atualizar utilizador: ' + error.message, 'error');
        }
        document.getElementById('loader').style.display = 'none';
    },

    toggleUserStatus: async (userId, isActive) => {
        document.getElementById('loader').style.display = 'flex';
        try {
            await dataService.updateUser(userId, { active: isActive });
            const user = dataService.users.find(u => u.id === userId);
            const statusText = isActive ? 'ativado' : 'desativado';
            uiService.showToast(`Utilizador ${user?.name || user?.email} foi ${statusText}.`, 'success');
            uiService.renderUserManagementTable();
        } catch (error) {
            uiService.showToast('Erro ao alterar status: ' + error.message, 'error');
            uiService.renderUserManagementTable();
        }
        document.getElementById('loader').style.display = 'none';
    },

    // --- TASK UI HELPERS ---
    populateAssignedUsersCheckboxes: function () {
        const container = document.getElementById('assigned-users-container');
        const badgesContainer = document.getElementById('selected-users-badges');
        container.innerHTML = '';
        if (badgesContainer) badgesContainer.innerHTML = '';

        const activeUsers = dataService.users.filter(u => u.email && u.active !== false);

        activeUsers.forEach(user => {
            const checkboxItem = document.createElement('div');
            checkboxItem.className = 'user-checkbox-item flex items-center gap-2 p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer transition-colors';
            checkboxItem.dataset.userId = user.id;
            checkboxItem.dataset.userName = (user.name || user.email.split('@')[0]).toLowerCase();

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = user.id;
            checkbox.id = `user-${user.id}`;
            checkbox.className = 'user-checkbox h-4 w-4 text-blue-600 rounded focus:ring-blue-500';

            // Avatar/inicial do usuário
            const avatar = document.createElement('div');
            const initial = (user.name || user.email)[0].toUpperCase();
            avatar.className = 'w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-bold flex-shrink-0';
            avatar.textContent = initial;

            const infoDiv = document.createElement('div');
            infoDiv.className = 'flex-1 min-w-0';

            const nameSpan = document.createElement('div');
            nameSpan.textContent = user.name || user.email.split('@')[0];
            nameSpan.className = 'text-sm font-medium text-gray-700 dark:text-gray-300 truncate';

            const roleSpan = document.createElement('div');
            roleSpan.textContent = user.role || 'Usuario';
            roleSpan.className = 'text-xs text-gray-500';

            infoDiv.appendChild(nameSpan);
            infoDiv.appendChild(roleSpan);

            checkboxItem.appendChild(checkbox);
            checkboxItem.appendChild(avatar);
            checkboxItem.appendChild(infoDiv);

            // Clicar no item inteiro marca o checkbox
            checkboxItem.addEventListener('click', (e) => {
                if (e.target !== checkbox) {
                    checkbox.checked = !checkbox.checked;
                }
                this.updateSelectedUsersBadges();
            });

            checkbox.addEventListener('change', () => {
                this.updateSelectedUsersBadges();
            });

            container.appendChild(checkboxItem);
        });
    },

    // Atualiza os badges dos usuários selecionados
    updateSelectedUsersBadges: function () {
        const badgesContainer = document.getElementById('selected-users-badges');
        if (!badgesContainer) return;

        const selectedCheckboxes = document.querySelectorAll('.user-checkbox:checked');
        badgesContainer.innerHTML = '';

        if (selectedCheckboxes.length === 0) {
            badgesContainer.innerHTML = '<span class="text-xs text-gray-400">Nenhum responsável selecionado</span>';
            return;
        }

        selectedCheckboxes.forEach(checkbox => {
            const user = dataService.users.find(u => u.id === checkbox.value);
            if (!user) return;

            const badge = document.createElement('span');
            badge.className = 'inline-flex items-center gap-1 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs px-2 py-1 rounded-full';
            badge.innerHTML = `
                ${user.name || user.email.split('@')[0]}
                <button type="button" class="hover:text-blue-900 dark:hover:text-blue-100" data-user-id="${user.id}">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            `;

            // Botão de remover
            badge.querySelector('button').addEventListener('click', (e) => {
                e.stopPropagation();
                checkbox.checked = false;
                this.updateSelectedUsersBadges();
            });

            badgesContainer.appendChild(badge);
        });
    },

    // Filtra usuários pela busca
    filterUserCheckboxes: function (searchTerm) {
        const items = document.querySelectorAll('.user-checkbox-item');
        const term = searchTerm.toLowerCase();

        items.forEach(item => {
            const userName = item.dataset.userName || '';
            if (userName.includes(term) || term === '') {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    },

    // Popula o select de tarefas pai
    populateParentTaskSelect: function (currentTaskId = null) {
        const select = document.getElementById('task-parent-select');
        if (!select) return;

        const project = dataService.getCurrentProject();
        if (!project) return;

        select.innerHTML = '<option value="">Nenhuma (tarefa principal)</option>';

        // Apenas tarefas que não são subtarefas podem ser pai
        const parentTasks = project.tasks.filter(t => !t.parentId && t.id !== currentTaskId);

        parentTasks.forEach(task => {
            const option = document.createElement('option');
            option.value = task.id;
            option.textContent = task.name;
            select.appendChild(option);
        });
    },

    // NOVA FUNÇÃO: Popula o select de responsáveis do projeto
    populateProjectManagerSelect: function () {
        const selectEl = document.getElementById('project-manager');
        selectEl.innerHTML = '<option value="">Selecione um responsável</option>';

        dataService.users.forEach(user => {
            const option = document.createElement('option');
            option.value = user.id;
            option.textContent = `${user.name || user.email.split('@')[0]} (${user.role})`;
            selectEl.appendChild(option);
        });
    },

    // NOVA FUNÇÃO: Popula o dropdown de setores no formulário de projeto
    populateSectorDropdown: function () {
        const selectEl = document.getElementById('project-sector');
        const containerEl = document.getElementById('project-sector-container');
        if (!selectEl) return;

        selectEl.innerHTML = '<option value="">Sem setor específico</option>';

        // Mostrar/ocultar baseado na role
        const role = dataService.userRole?.toLowerCase();
        if (role === 'admin') {
            // Admin vê todos os setores
            containerEl?.classList.remove('hidden');
            dataService.sectors.forEach(sector => {
                const option = document.createElement('option');
                option.value = sector.id;
                option.textContent = sector.name;
                selectEl.appendChild(option);
            });
        } else if (role === 'gestor') {
            // Gestor só vê seu setor (pré-selecionado)
            containerEl?.classList.remove('hidden');
            const userSector = dataService.sectors.find(s => s.id === dataService.userSectorId);
            if (userSector) {
                const option = document.createElement('option');
                option.value = userSector.id;
                option.textContent = userSector.name;
                option.selected = true;
                selectEl.appendChild(option);
            }
            selectEl.disabled = true; // Gestor não pode mudar o setor
        } else {
            // Usuário comum não vê o dropdown
            containerEl?.classList.add('hidden');
        }
    },

    // NOVA FUNÇÃO: Renderizar tabela de gestão de setores
    renderSectorManagementTable: function () {
        const tableBody = document.getElementById('sector-management-table-body');
        if (!tableBody) return;

        tableBody.innerHTML = '';

        if (dataService.sectors.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="5" class="p-4 text-center text-gray-500">
                        Nenhum setor cadastrado. Clique em "Novo Setor" para criar.
                    </td>
                </tr>
            `;
            return;
        }

        dataService.sectors.forEach(sector => {
            // Contar projetos do setor
            const projectCount = dataService.projects.filter(p => p.sectorId === sector.id).length;
            // Contar gestores do setor
            const gestorCount = dataService.users.filter(u => u.sectorId === sector.id && u.role?.toLowerCase() === 'gestor').length;

            const row = document.createElement('tr');
            row.className = 'border-b border-gray-700 hover:bg-gray-800';
            row.innerHTML = `
                <td class="p-3 font-medium text-[var(--text-color)]">${sector.name}</td>
                <td class="p-3 text-gray-400">${sector.description || '-'}</td>
                <td class="p-3">
                    <span class="bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-300 text-xs px-2 py-1 rounded-full">
                        ${projectCount}
                    </span>
                </td>
                <td class="p-3">
                    <span class="bg-yellow-100 dark:bg-yellow-900 text-yellow-600 dark:text-yellow-300 text-xs px-2 py-1 rounded-full">
                        ${gestorCount}
                    </span>
                </td>
                <td class="p-3 text-center">
                    <div class="flex justify-center gap-2">
                        <button onclick="uiService.openSectorFormModal('${sector.id}')"
                            class="text-blue-500 hover:text-blue-400 p-1" title="Editar">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                            </svg>
                        </button>
                        <button onclick="uiService.confirmDeleteSector('${sector.id}', '${sector.name}')"
                            class="text-red-500 hover:text-red-400 p-1" title="Excluir">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                            </svg>
                        </button>
                    </div>
                </td>
            `;
            tableBody.appendChild(row);
        });
    },

    // NOVA FUNÇÃO: Abrir modal de formulário de setor
    openSectorFormModal: function (sectorId = null) {
        const title = document.getElementById('sector-form-title');
        const nameInput = document.getElementById('sector-name');
        const descInput = document.getElementById('sector-description');
        const idInput = document.getElementById('sector-id');

        if (sectorId) {
            const sector = dataService.getSectorById(sectorId);
            if (sector) {
                title.textContent = 'Editar Setor';
                nameInput.value = sector.name;
                descInput.value = sector.description || '';
                idInput.value = sectorId;
            }
        } else {
            title.textContent = 'Novo Setor';
            nameInput.value = '';
            descInput.value = '';
            idInput.value = '';
        }

        this.openModal('sector-form-modal');
    },

    // NOVA FUNÇÃO: Confirmar exclusão de setor
    confirmDeleteSector: async function (sectorId, sectorName) {
        const confirmed = await this.showConfirmModalPromise(
            `Tem certeza que deseja excluir o setor "${sectorName}"?`,
            'Excluir Setor'
        );

        if (confirmed) {
            await dataService.deleteSector(sectorId);
        }
    },

    // NOVA FUNÇÃO: Mostrar modal de confirmação para datas de subtarefas
    showSubtaskDateConfirmModal: function (subtaskName, subtaskStartDate, subtaskEndDate, parentStartDate, parentEndDate) {
        return new Promise((resolve) => {
            this.subtaskDateConfirmResolve = resolve;

            const body = document.getElementById('subtask-date-confirm-body');
            body.innerHTML = `
                A subtarefa "<strong>${subtaskName}</strong>" possui datas fora do intervalo da tarefa pai.<br><br>
                <strong>Subtarefa:</strong> ${new Date(subtaskStartDate).toLocaleDateString('pt-BR')} - ${new Date(subtaskEndDate).toLocaleDateString('pt-BR')}<br>
                <strong>Tarefa Pai:</strong> ${new Date(parentStartDate).toLocaleDateString('pt-BR')} - ${new Date(parentEndDate).toLocaleDateString('pt-BR')}<br><br>
                Deseja ajustar as datas da tarefa pai para acomodar a subtarefa?
            `;

            this.openModal('subtask-date-confirm-modal');
        });
    },

    // NOVA FUNÇÃO: Mostrar modal de ajustes de importação
    showImportAdjustmentModal: function (importResults) {
        this.openModal('import-adjustment-modal');

        // Atualizar contadores
        document.getElementById('import-valid-count').textContent = importResults.validTasks.length;
        document.getElementById('import-total-count').textContent = importResults.validTasks.length + importResults.invalidTasks.length;
        document.getElementById('confirm-count').textContent = importResults.validTasks.length;

        // Listar erros gerais
        const errorsList = document.getElementById('import-errors-list');
        const errorMessages = [...new Set(importResults.invalidTasks.flatMap(item => item.errors))];
        errorsList.innerHTML = errorMessages.map(error =>
            `<div>• ${error}</div>`
        ).join('');

        // Preencher tabela de ajustes
        const tableBody = document.getElementById('import-adjustment-table-body');
        tableBody.innerHTML = '';

        importResults.invalidTasks.forEach((item, index) => {
            const row = document.createElement('tr');
            row.className = 'border-b border-[var(--border-color)] import-error-row';

            // Buscar opções de tarefas pai
            const parentOptions = this.getParentTaskOptions(importResults.taskNameMap);

            row.innerHTML = `
                <td class="p-2">${item.row}</td>
                <td class="p-2">
                    <input type="text" class="adjust-task-name border border-[var(--border-color)] rounded p-1 w-full text-black" 
                           value="${item.data['Tarefa'] || ''}" data-index="${index}">
                </td>
                <td class="p-2">
                    <input type="date" class="adjust-start-date border border-[var(--border-color)] rounded p-1 w-full text-black" 
                           value="${item.task.startDate || ''}" data-index="${index}">
                </td>
                <td class="p-2">
                    <input type="date" class="adjust-end-date border border-[var(--border-color)] rounded p-1 w-full text-black" 
                           value="${item.task.endDate || ''}" data-index="${index}">
                </td>
                <td class="p-2">
                    <select class="adjust-status border border-[var(--border-color)] rounded p-1 w-full text-black" data-index="${index}">
                        <option value="Não Iniciada" ${item.task.status === 'Não Iniciada' ? 'selected' : ''}>Não Iniciada</option>
                        <option value="Em Andamento" ${item.task.status === 'Em Andamento' ? 'selected' : ''}>Em Andamento</option>
                        <option value="Concluída" ${item.task.status === 'Concluída' ? 'selected' : ''}>Concluída</option>
                    </select>
                </td>
                <td class="p-2">
                    <input type="text" class="adjust-assigned border border-[var(--border-color)] rounded p-1 w-full text-black" 
                           value="${item.data['Atribuído a (Nomes Separados por Vírgula)'] || ''}" 
                           placeholder="Nomes separados por vírgula" data-index="${index}">
                </td>
                <td class="p-2">
                    <select class="adjust-parent border border-[var(--border-color)] rounded p-1 w-full text-black" data-index="${index}">
                        <option value="">Nenhuma</option>
                        ${parentOptions}
                    </select>
                </td>
                <td class="p-2 text-red-500 text-xs">
                    ${item.errors.join(', ')}
                </td>
                <td class="p-2 text-center">
                    <button class="validate-row-btn bg-blue-500 text-white px-2 py-1 rounded text-xs hover:bg-blue-600" data-index="${index}">
                        Validar
                    </button>
                </td>
            `;
            tableBody.appendChild(row);

            // Configurar tarefa pai se existir
            if (item.data['Tarefa Pai (Nome)']) {
                const parentSelect = row.querySelector('.adjust-parent');
                const parentName = item.data['Tarefa Pai (Nome)'].toLowerCase();
                Array.from(parentSelect.options).forEach(option => {
                    if (option.text.toLowerCase() === parentName) {
                        option.selected = true;
                    }
                });
            }
        });

        // Configurar event listeners
        this.setupImportAdjustmentEvents(importResults);
    },

    // FUNÇÃO: Obter opções de tarefas pai
    getParentTaskOptions: function (taskNameMap) {
        let options = '';
        taskNameMap.forEach((id, name) => {
            // Capitalizar nome para exibição
            const displayName = name.charAt(0).toUpperCase() + name.slice(1);
            options += `<option value="${id}">${displayName}</option>`;
        });
        return options;
    },

    // FUNÇÃO: Configurar eventos do modal de ajustes
    setupImportAdjustmentEvents: function (importResults) {
        let currentResults = importResults;

        // Botão validar linha
        document.querySelectorAll('.validate-row-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.dataset.index);
                this.validateSingleRow(index, currentResults);
            });
        });

        // Botão cancelar
        document.getElementById('cancel-import-btn').onclick = () => {
            this.closeModal('import-adjustment-modal');
            uiService.showToast('Importação cancelada', 'error');
        };

        // Botão confirmar importação
        document.getElementById('confirm-import-btn').onclick = async () => {
            document.getElementById('loader').style.display = 'flex';
            try {
                await dataService.finalizeImport(currentResults.validTasks, dataService.getCurrentProject());
                this.closeModal('import-adjustment-modal');
                uiService.showToast(`${currentResults.validTasks.length} tarefas importadas com sucesso!`, 'success');
            } catch (error) {
                console.error('Erro ao finalizar importação:', error);
                uiService.showToast('Erro ao importar tarefas', 'error');
            } finally {
                document.getElementById('loader').style.display = 'none';
            }
        };
    },

    // FUNÇÃO: Validar linha individual no modal
    validateSingleRow: function (rowIndex, importResults) {
        const row = importResults.invalidTasks[rowIndex];
        const rowElement = document.querySelectorAll('#import-adjustment-table-body tr')[rowIndex];

        // Coletar dados atualizados
        const updatedData = {
            'Tarefa': rowElement.querySelector('.adjust-task-name').value,
            'Data Início': rowElement.querySelector('.adjust-start-date').value,
            'Data Termino': rowElement.querySelector('.adjust-end-date').value,
            'Status': rowElement.querySelector('.adjust-status').value,
            'Atribuído a (Nomes Separados por Vírgula)': rowElement.querySelector('.adjust-assigned').value,
            'Tarefa Pai (Nome)': rowElement.querySelector('.adjust-parent').selectedOptions[0]?.text || ''
        };

        // Validar novamente
        const project = dataService.getCurrentProject();
        const validationResult = dataService.validateImportRow(updatedData, row.row, importResults.taskNameMap, project.startDate);

        if (validationResult.isValid) {
            // Mover para válidas
            importResults.validTasks.push(validationResult.task);
            importResults.invalidTasks.splice(rowIndex, 1);

            // Atualizar UI
            this.showImportAdjustmentModal(importResults);
            uiService.showToast('Linha corrigida e validada!', 'success');
        } else {
            // Atualizar erros
            row.errors = validationResult.errors;
            const errorCell = rowElement.querySelector('td:nth-child(8)');
            errorCell.innerHTML = validationResult.errors.join(', ');
            errorCell.className = 'p-2 text-red-500 text-xs';

            uiService.showToast('Ainda há problemas na linha', 'error');
        }
    },

    // NOVA FUNÇÃO: Modal de confirmação que retorna uma Promise
    showConfirmModalPromise: function (message, title = 'Confirmar Ação') {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirm-modal');
            const titleEl = document.getElementById('confirm-modal-title');
            const bodyEl = document.getElementById('confirm-modal-body');
            const okBtn = document.getElementById('confirm-ok-btn');
            const cancelBtn = document.getElementById('confirm-cancel-btn');

            titleEl.textContent = title;
            bodyEl.textContent = message;

            // Remover event listeners anteriores
            const newOkBtn = okBtn.cloneNode(true);
            const newCancelBtn = cancelBtn.cloneNode(true);
            okBtn.parentNode.replaceChild(newOkBtn, okBtn);
            cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

            const cleanup = () => {
                newOkBtn.removeEventListener('click', onConfirm);
                newCancelBtn.removeEventListener('click', onCancel);
                this.closeModal('confirm-modal');
            };

            const onConfirm = () => {
                cleanup();
                resolve(true);
            };

            const onCancel = () => {
                cleanup();
                resolve(false);
            };

            newOkBtn.addEventListener('click', onConfirm);
            newCancelBtn.addEventListener('click', onCancel);

            this.openModal('confirm-modal');
        });
    },

    // NOVA FUNÇÃO: Alternar entre visualização Cards/Lista
    switchProjectView: function (viewType) {
        const cardsBtn = document.getElementById('view-cards-btn');
        const listBtn = document.getElementById('view-list-btn');
        const cardView = document.getElementById('project-list');
        const listView = document.getElementById('project-list-table');

        if (viewType === 'cards') {
            // Ativar cards
            cardsBtn.classList.add('bg-blue-600', 'text-white');
            cardsBtn.classList.remove('bg-gray-300', 'text-gray-800');

            listBtn.classList.add('bg-gray-300', 'text-gray-800');
            listBtn.classList.remove('bg-blue-600', 'text-white');

            // Mostrar cards, ocultar lista
            cardView.classList.remove('hidden');
            listView.classList.add('hidden');

        } else if (viewType === 'list') {
            // Ativar lista
            listBtn.classList.add('bg-blue-600', 'text-white');
            listBtn.classList.remove('bg-gray-300', 'text-gray-800');

            cardsBtn.classList.add('bg-gray-300', 'text-gray-800');
            cardsBtn.classList.remove('bg-blue-600', 'text-white');

            // Mostrar lista, ocultar cards
            listView.classList.remove('hidden');
            cardView.classList.add('hidden');

            // Renderizar a lista se necessário
            this.renderProjectListTable(this.getFilteredProjects());
        }
    },

    // Estado atual da aba de projetos
    currentProjectTab: 'active',

    // Função para obter projetos filtrados por aba
    getFilteredProjects: function () {
        if (this.currentProjectTab === 'finalized') {
            return dataService.projects.filter(p => p.finalized === true);
        } else {
            return dataService.projects.filter(p => !p.finalized);
        }
    },

    // Função para alternar entre abas de projetos
    switchProjectTab: function (tabType) {
        this.currentProjectTab = tabType;

        const activeTab = document.getElementById('tab-active-projects');
        const finalizedTab = document.getElementById('tab-finalized-projects');
        const addProjectBtn = document.getElementById('add-project-btn');

        if (tabType === 'active') {
            // Ativar aba de projetos ativos
            activeTab.classList.add('border-blue-600', 'text-blue-600', 'dark:text-blue-400');
            activeTab.classList.remove('border-transparent', 'text-gray-500');

            finalizedTab.classList.remove('border-blue-600', 'text-blue-600', 'dark:text-blue-400');
            finalizedTab.classList.add('border-transparent', 'text-gray-500');

            // Mostrar botão de adicionar projeto
            addProjectBtn.classList.remove('hidden');

        } else if (tabType === 'finalized') {
            // Ativar aba de projetos finalizados
            finalizedTab.classList.add('border-blue-600', 'text-blue-600', 'dark:text-blue-400');
            finalizedTab.classList.remove('border-transparent', 'text-gray-500');

            activeTab.classList.remove('border-blue-600', 'text-blue-600', 'dark:text-blue-400');
            activeTab.classList.add('border-transparent', 'text-gray-500');

            // Ocultar botão de adicionar projeto na aba de finalizados
            addProjectBtn.classList.add('hidden');
        }

        // Atualizar lista de projetos
        const filteredProjects = this.getFilteredProjects();
        this.renderProjectList(filteredProjects);
        this.renderProjectListTable(filteredProjects);
    },

    // Atualizar contadores das abas
    updateProjectTabCounts: function () {
        const activeCount = dataService.projects.filter(p => !p.finalized).length;
        const finalizedCount = dataService.projects.filter(p => p.finalized === true).length;

        document.getElementById('active-projects-count').textContent = activeCount;
        document.getElementById('finalized-projects-count').textContent = finalizedCount;
    },

    // NOVA FUNÇÃO: Renderizar lista de projetos em formato de tabela
    renderProjectListTable: function (projects) {
        const body = document.getElementById("project-table-body");

        if (!projects || projects.length === 0) {
            body.innerHTML = `<tr><td colspan="7" class="text-center p-4 text-gray-400">Nenhum projeto encontrado.</td></tr>`;
            return;
        }

        body.innerHTML = projects.map(p => {
            const progress = dataService.getProjectProgress(p.tasks);
            const manager = dataService.getManagerName(p.manager) || "Não informado";
            const start = p.startDate ? new Date(p.startDate).toLocaleDateString("pt-BR") : "—";
            const end = p.endDate ? new Date(p.endDate).toLocaleDateString("pt-BR") : "—";
            const status = progress === 100 ? "Concluído" : progress > 0 ? "Em Andamento" : "Não iniciado";

            // Verificar se o projeto está atrasado
            const today = new Date();
            const endDate = p.endDate ? new Date(p.endDate) : null;
            const isOverdue = endDate && endDate < today && progress < 100;
            const rowClass = isOverdue ? 'project-overdue' : '';

            return `
                <tr class="border-b border-[var(--border-color)] ${rowClass} project-row cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" data-project-id="${p.id}">
                    <td class="p-3 font-medium text-blue-600 dark:text-blue-400 hover:underline">${p.name}</td>
                    <td class="p-3">${manager}</td>
                    <td class="p-3">
                        <div class="flex items-center gap-2">
                            <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                                <div class="bg-blue-600 h-2 rounded-full" style="width: ${progress}%"></div>
                            </div>
                            <span class="text-sm">${progress}%</span>
                        </div>
                    </td>
                    <td class="p-3">
                        <span class="px-2 py-1 rounded-full text-xs ${isOverdue ? 'bg-red-600 text-white' : status === 'Concluído' ? 'bg-green-600 text-white' : status === 'Em Andamento' ? 'bg-yellow-500 text-black' : 'bg-gray-500 text-white'}">
                            ${isOverdue ? 'Atrasado' : status}
                        </span>
                    </td>
                    <td class="p-3">${start}</td>
                    <td class="p-3">${end}</td>
                    <td class="p-3 text-center project-actions" onclick="event.stopPropagation()">
                        <button class="delete-project bg-red-600 text-white px-2 py-1 rounded text-xs hover:bg-red-700" data-id="${p.id}">Excluir</button>
                    </td>
                </tr>`;
        }).join("");

        // Adicionar event listeners
        setTimeout(() => {
            // Clique na linha inteira abre o projeto
            document.querySelectorAll(".project-row").forEach(row => {
                row.addEventListener("click", () => {
                    const projectId = row.dataset.projectId;
                    if (projectId) {
                        App.openProject(projectId);
                    }
                });
            });

            document.querySelectorAll(".delete-project").forEach(btn => {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation(); // Evita abrir o projeto ao clicar em excluir
                    uiService.showConfirmModal("Excluir o projeto?", async () => {
                        document.getElementById('loader').style.display = 'flex';
                        await dataService.deleteProject(btn.dataset.id);
                        document.getElementById('loader').style.display = 'none';
                        uiService.showToast("Projeto excluído", "error");
                    });
                });
            });
        }, 20);
    },

    // FUNÇÃO ATUALIZADA: Configurar drag and drop para TODAS as tarefas
    setupSubtasksDragAndDrop: function () {
        const tableBody = document.getElementById('task-table-body');

        // Limpar event listeners anteriores
        tableBody.querySelectorAll('tr').forEach(row => {
            row.removeEventListener('dragstart', this.handleDragStart);
            row.removeEventListener('dragover', this.handleDragOver);
            row.removeEventListener('drop', this.handleDrop);
            row.removeEventListener('dragend', this.handleDragEnd);
            row.removeEventListener('dragleave', this.handleDragLeave);
            row.draggable = false;
        });

        // Encontrar TODAS as linhas de tarefas (não apenas subtarefas)
        const allTaskRows = Array.from(tableBody.querySelectorAll('tr.draggable-task'));

        console.log(`🔧 Configurando drag and drop para ${allTaskRows.length} tarefas`);

        // Configurar drag and drop para cada tarefa
        allTaskRows.forEach(row => {
            row.setAttribute('draggable', 'true');
            row.addEventListener('dragstart', this.handleDragStart.bind(this));
            row.addEventListener('dragover', this.handleDragOver.bind(this));
            row.addEventListener('drop', this.handleDrop.bind(this));
            row.addEventListener('dragend', this.handleDragEnd.bind(this));
            row.addEventListener('dragleave', this.handleDragLeave.bind(this));

            // Adicionar feedback visual
            row.style.transition = 'all 0.2s ease';
        });
    },

    // Armazenar o ID da tarefa sendo arrastada
    draggingTaskId: null,

    // Handlers para drag and drop (ATUALIZADOS para todas as tarefas)
    handleDragStart: function (e) {
        const row = e.target.closest('tr');
        if (!row) return;

        const taskId = parseFloat(row.dataset.taskId);
        if (!taskId) return;

        this.draggingTaskId = taskId;
        e.dataTransfer.setData('text/plain', taskId.toString());
        e.dataTransfer.effectAllowed = 'move';

        row.classList.add('dragging');
        row.style.opacity = '0.5';

        console.log(`🚀 Iniciando drag da tarefa: ${taskId}`);
    },

    handleDragOver: function (e) {
        e.preventDefault();
        const row = e.target.closest('tr');
        if (!row || !this.draggingTaskId) return;

        const targetTaskId = parseFloat(row.dataset.taskId);
        const canReorderSameLevel = this.canReorder(this.draggingTaskId, targetTaskId);
        const canMakeChild = this.canMakeSubtask(this.draggingTaskId, targetTaskId);
        const canPromote = this.canPromoteToRoot(this.draggingTaskId, targetTaskId);

        if (canReorderSameLevel || canMakeChild || canPromote) {
            e.dataTransfer.dropEffect = 'move';

            // Limpar outros indicadores
            document.querySelectorAll('.drag-over, .drag-inside, .drag-promote').forEach(r => {
                if (r !== row) {
                    r.classList.remove('drag-over', 'drag-inside', 'drag-promote');
                    r.style.borderTop = '';
                    r.style.borderBottom = '';
                    r.style.backgroundColor = '';
                }
            });

            // Determinar zona: topo (40%), centro (20%), baixo (40%)
            // Zona central menor facilita promoção de subtarefas
            const rect = row.getBoundingClientRect();
            const topZone = rect.top + rect.height * 0.40;
            const bottomZone = rect.top + rect.height * 0.60;

            row.classList.add('drag-over');

            // Prioridade: promoção > reordenar > tornar subtarefa
            if (e.clientY < topZone) {
                // Zona superior (40%) - inserir antes ou promover
                row.classList.remove('drag-inside', 'drag-promote');
                if (canPromote) {
                    row.style.borderTop = '3px solid #f59e0b';
                    row.style.backgroundColor = 'rgba(245, 158, 11, 0.1)';
                    row.dataset.dropPosition = 'promote-before';
                } else if (canReorderSameLevel) {
                    row.style.borderTop = '3px solid #3b82f6';
                    row.style.backgroundColor = '';
                    row.dataset.dropPosition = 'before';
                }
                row.style.borderBottom = '';
            } else if (e.clientY > bottomZone) {
                // Zona inferior (40%) - inserir depois ou promover
                row.classList.remove('drag-inside', 'drag-promote');
                if (canPromote) {
                    row.style.borderBottom = '3px solid #f59e0b';
                    row.style.backgroundColor = 'rgba(245, 158, 11, 0.1)';
                    row.dataset.dropPosition = 'promote-after';
                } else if (canReorderSameLevel) {
                    row.style.borderBottom = '3px solid #3b82f6';
                    row.style.backgroundColor = '';
                    row.dataset.dropPosition = 'after';
                }
                row.style.borderTop = '';
            } else if (canMakeChild) {
                // Zona central (20%) - tornar subtarefa
                row.classList.add('drag-inside');
                row.classList.remove('drag-promote');
                row.style.borderTop = '';
                row.style.borderBottom = '';
                row.style.backgroundColor = 'rgba(34, 197, 94, 0.2)';
                row.dataset.dropPosition = 'inside';
            } else if (canReorderSameLevel) {
                // Fallback para reordenar
                row.style.borderBottom = '3px solid #3b82f6';
                row.style.borderTop = '';
                row.style.backgroundColor = '';
                row.dataset.dropPosition = 'after';
            } else if (canPromote) {
                // Fallback para promover
                row.classList.add('drag-promote');
                row.style.borderBottom = '3px solid #f59e0b';
                row.style.borderTop = '';
                row.style.backgroundColor = 'rgba(245, 158, 11, 0.1)';
                row.dataset.dropPosition = 'promote-after';
            }
        } else {
            e.dataTransfer.dropEffect = 'none';
        }
    },

    handleDragLeave: function (e) {
        const row = e.target.closest('tr');
        if (row) {
            row.classList.remove('drag-over', 'drag-inside', 'drag-promote');
            row.style.borderTop = '';
            row.style.borderBottom = '';
            row.style.backgroundColor = '';
        }
    },

    handleDrop: function (e) {
        e.preventDefault();
        const targetRow = e.target.closest('tr');
        if (!targetRow || !this.draggingTaskId) return;

        const targetTaskId = parseFloat(targetRow.dataset.taskId);
        const dropPosition = targetRow.dataset.dropPosition || 'before';

        console.log(`🎯 Soltando tarefa ${this.draggingTaskId} ${dropPosition} da tarefa ${targetTaskId}`);

        if (dropPosition === 'inside') {
            // Tornar subtarefa
            if (this.canMakeSubtask(this.draggingTaskId, targetTaskId)) {
                this.makeTaskSubtask(this.draggingTaskId, targetTaskId);
            }
        } else if (dropPosition === 'promote-before' || dropPosition === 'promote-after') {
            // Promover subtarefa para tarefa principal
            if (this.canPromoteToRoot(this.draggingTaskId, targetTaskId)) {
                const position = dropPosition === 'promote-before' ? 'before' : 'after';
                this.makeTaskTopLevel(this.draggingTaskId, targetTaskId, position);
            }
        } else {
            // Reordenar normalmente
            if (this.canReorder(this.draggingTaskId, targetTaskId)) {
                this.reorderTasks(this.draggingTaskId, targetTaskId, dropPosition);
            }
        }

        this.cleanupDragState();
    },

    handleDragEnd: function (e) {
        console.log('🔚 Drag finalizado');
        this.cleanupDragState();
    },

    cleanupDragState: function () {
        this.draggingTaskId = null;
        const tableBody = document.getElementById('task-table-body');
        tableBody.querySelectorAll('tr').forEach(row => {
            row.classList.remove('dragging', 'drag-over', 'drag-inside', 'drag-promote');
            row.style.opacity = '';
            row.style.borderTop = '';
            row.style.borderBottom = '';
            row.style.backgroundColor = '';
            delete row.dataset.dropPosition;
        });
    },

    getTaskIdFromRow: function (row) {
        return row ? parseFloat(row.dataset.taskId) : null;
    },

    canReorder: function (draggingTaskId, targetTaskId) {
        if (!draggingTaskId || !targetTaskId) return false;
        if (draggingTaskId === targetTaskId) return false;

        const project = dataService.getCurrentProject();
        if (!project) return false;

        const draggingTask = project.tasks.find(t => t.id === draggingTaskId);
        const targetTask = project.tasks.find(t => t.id === targetTaskId);

        if (!draggingTask || !targetTask) return false;

        // Converter null/undefined para 'root' para comparação consistente
        const draggingParent = draggingTask.parentId || null;
        const targetParent = targetTask.parentId || null;

        // Só pode reordenar se ambas as tarefas tiverem o mesmo pai (ou ambas forem raiz)
        return draggingParent === targetParent;
    },

    canMakeSubtask: function (draggingTaskId, targetTaskId) {
        if (!draggingTaskId || !targetTaskId) return false;
        if (draggingTaskId === targetTaskId) return false;

        const project = dataService.getCurrentProject();
        if (!project) return false;

        const draggingTask = project.tasks.find(t => t.id === draggingTaskId);
        const targetTask = project.tasks.find(t => t.id === targetTaskId);

        if (!draggingTask || !targetTask) return false;

        // Não pode tornar subtarefa de si mesmo
        if (draggingTask.id === targetTask.id) return false;

        // A tarefa arrastada não pode já ser subtarefa da tarefa alvo
        if (draggingTask.parentId === targetTaskId) return false;

        // A tarefa alvo não pode ser uma subtarefa (só tarefas principais podem ter filhos)
        if (targetTask.parentId) return false;

        // Não pode criar dependência circular (a tarefa alvo não pode ser filho da arrastada)
        const isTargetChildOfDragging = project.tasks.some(t =>
            t.id === targetTaskId && t.parentId === draggingTaskId
        );
        if (isTargetChildOfDragging) return false;

        // A tarefa arrastada não pode ter subtarefas (mover junto seria muito complexo)
        const hasChildren = project.tasks.some(t => t.parentId === draggingTaskId);
        if (hasChildren) return false;

        return true;
    },

    makeTaskSubtask: async function (taskId, newParentId) {
        const project = dataService.getCurrentProject();
        if (!project) return;

        const task = project.tasks.find(t => t.id === taskId);
        const newParent = project.tasks.find(t => t.id === newParentId);

        if (!task || !newParent) return;

        console.log(`🔄 Convertendo "${task.name}" em subtarefa de "${newParent.name}"`);

        // Calcular nova ordem entre as subtarefas do novo pai
        const siblings = project.tasks.filter(t => t.parentId === newParentId);
        const newOrder = siblings.length;

        // Atualizar a tarefa
        const updatedTasks = project.tasks.map(t => {
            if (t.id === taskId) {
                return {
                    ...t,
                    parentId: newParentId,
                    dependsOn: newParentId,
                    order: newOrder,
                    manualOrder: true
                };
            }
            return t;
        });

        // Ajustar datas do pai se necessário
        const taskDates = dataService.getLatestDates(task);
        const parentDates = dataService.getLatestDates(newParent);

        if (taskDates && parentDates) {
            const taskStart = new Date(taskDates.startDate);
            const taskEnd = new Date(taskDates.endDate);
            const parentStart = new Date(parentDates.startDate);
            const parentEnd = new Date(parentDates.endDate);

            if (taskStart < parentStart || taskEnd > parentEnd) {
                const newParentStart = new Date(Math.min(parentStart.getTime(), taskStart.getTime())).toISOString().split('T')[0];
                const newParentEnd = new Date(Math.max(parentEnd.getTime(), taskEnd.getTime())).toISOString().split('T')[0];

                const finalTasks = updatedTasks.map(t => {
                    if (t.id === newParentId) {
                        return {
                            ...t,
                            dateHistory: [
                                ...(t.dateHistory || []),
                                { startDate: newParentStart, endDate: newParentEnd }
                            ]
                        };
                    }
                    return t;
                });
                project.tasks = finalTasks;
            } else {
                project.tasks = updatedTasks;
            }
        } else {
            project.tasks = updatedTasks;
        }

        // Recalcular progresso
        dataService.recalculateAllProgress();

        // Salvar no Firebase
        document.getElementById('loader').style.display = 'flex';
        try {
            await dataService.saveProjectDocument(project);
            uiService.showToast(`"${task.name}" agora é subtarefa de "${newParent.name}"`, 'success');

            // Atualizar UI
            const currentFilter = document.getElementById('task-filter-input').value;
            uiService.renderProjectDashboard(project, currentFilter);
        } catch (error) {
            console.error('Erro ao salvar:', error);
            uiService.showToast('Erro ao salvar alteração', 'error');
        } finally {
            document.getElementById('loader').style.display = 'none';
        }
    },

    canPromoteToRoot: function (draggingTaskId, targetTaskId) {
        if (!draggingTaskId || !targetTaskId) return false;
        if (draggingTaskId === targetTaskId) return false;

        const project = dataService.getCurrentProject();
        if (!project) return false;

        const draggingTask = project.tasks.find(t => t.id === draggingTaskId);
        const targetTask = project.tasks.find(t => t.id === targetTaskId);

        if (!draggingTask || !targetTask) return false;

        // A tarefa arrastada deve ser uma subtarefa (ter parentId)
        if (!draggingTask.parentId) return false;

        // A tarefa alvo deve ser uma tarefa principal (não ter parentId)
        if (targetTask.parentId) return false;

        // A tarefa alvo não pode ser o pai atual da tarefa arrastada
        if (targetTask.id === draggingTask.parentId) return false;

        return true;
    },

    makeTaskTopLevel: async function (taskId, targetTaskId, position) {
        const project = dataService.getCurrentProject();
        if (!project) return;

        const task = project.tasks.find(t => t.id === taskId);
        const targetTask = project.tasks.find(t => t.id === targetTaskId);
        const oldParent = project.tasks.find(t => t.id === task?.parentId);

        if (!task || !targetTask) return;

        console.log(`⬆️ Promovendo "${task.name}" para tarefa principal (${position} de "${targetTask.name}")`);

        // Obter todas as tarefas principais ordenadas
        const rootTasks = project.tasks
            .filter(t => !t.parentId)
            .sort((a, b) => (a.order || 0) - (b.order || 0));

        // Encontrar a posição do alvo
        const targetIndex = rootTasks.findIndex(t => t.id === targetTaskId);
        const newOrder = position === 'before' ? targetIndex : targetIndex + 1;

        // Reordenar as outras tarefas principais
        const updatedTasks = project.tasks.map(t => {
            if (t.id === taskId) {
                // Promover a tarefa - remover parentId e dependsOn
                return {
                    ...t,
                    parentId: null,
                    dependsOn: null,
                    order: newOrder,
                    manualOrder: true
                };
            }
            // Ajustar ordem das outras tarefas principais
            if (!t.parentId && t.id !== taskId) {
                const currentOrder = t.order || 0;
                if (currentOrder >= newOrder) {
                    return { ...t, order: currentOrder + 1 };
                }
            }
            return t;
        });

        project.tasks = updatedTasks;

        // Recalcular progresso
        dataService.recalculateAllProgress();

        // Salvar no Firebase
        document.getElementById('loader').style.display = 'flex';
        try {
            await dataService.saveProjectDocument(project);
            const parentName = oldParent ? oldParent.name : 'pai';
            uiService.showToast(`"${task.name}" agora é tarefa independente`, 'success');

            // Atualizar UI
            const currentFilter = document.getElementById('task-filter-input').value;
            uiService.renderProjectDashboard(project, currentFilter);
        } catch (error) {
            console.error('Erro ao salvar:', error);
            uiService.showToast('Erro ao salvar alteração', 'error');
        } finally {
            document.getElementById('loader').style.display = 'none';
        }
    },

    reorderTasks: async function (draggingTaskId, targetTaskId, position) {
        const project = dataService.getCurrentProject();
        if (!project) {
            console.log('❌ Nenhum projeto encontrado para reordenar');
            return;
        }

        const draggingTask = project.tasks.find(t => t.id === draggingTaskId);
        const targetTask = project.tasks.find(t => t.id === targetTaskId);

        if (!draggingTask || !targetTask) {
            console.log('❌ Tarefas não encontradas');
            return;
        }

        const parentId = draggingTask.parentId || null;

        // Obter todas as tarefas do mesmo nível
        const siblingTasks = project.tasks
            .filter(t => (t.parentId || null) === parentId)
            .sort((a, b) => (a.order || 0) - (b.order || 0));

        console.log(`📋 Tarefas antes:`, siblingTasks.map(t => ({ id: t.id, name: t.name, order: t.order })));

        // Remover a tarefa que está sendo arrastada
        const filteredTasks = siblingTasks.filter(t => t.id !== draggingTaskId);

        // Encontrar a posição da tarefa alvo
        let targetIndex = filteredTasks.findIndex(t => t.id === targetTaskId);

        if (targetIndex === -1) {
            console.log('❌ Índice alvo não encontrado');
            return;
        }

        // Ajustar índice baseado na posição (before/after)
        if (position === 'after') {
            targetIndex += 1;
        }

        // Inserir a tarefa arrastada na nova posição
        const reorderedTasks = [
            ...filteredTasks.slice(0, targetIndex),
            draggingTask,
            ...filteredTasks.slice(targetIndex)
        ];

        // Atualizar a ordem e marcar como ordem manual
        reorderedTasks.forEach((task, index) => {
            const projectTask = project.tasks.find(t => t.id === task.id);
            if (projectTask) {
                projectTask.order = index;
                projectTask.manualOrder = true; // Marcar como ordem manual
            }
        });

        console.log(`📋 Tarefas depois:`, reorderedTasks.map(t => ({ id: t.id, name: t.name, order: t.order })));

        document.getElementById('loader').style.display = 'flex';
        try {
            // Salvar no Firebase
            await dataService.saveProjectDocument(project);

            // Re-renderizar a tabela com filtro aplicado
            const currentFilter = document.getElementById('task-filter-input').value;
            const filteredTasks = project.tasks.filter(t =>
                t.name.toLowerCase().includes(currentFilter.toLowerCase()) ||
                (t.assignedUsers && t.assignedUsers.some(uid => {
                    const user = dataService.users.find(u => u.id === uid);
                    return user && user.email.toLowerCase().includes(currentFilter.toLowerCase());
                }))
            );
            this.renderTaskTable(filteredTasks);

            uiService.showToast('Tarefas reordenadas com sucesso!');
        } catch (error) {
            console.error('Erro ao reordenar tarefas:', error);
            uiService.showToast('Erro ao reordenar tarefas', 'error');
        } finally {
            document.getElementById('loader').style.display = 'none';
        }
    },

    // Manter compatibilidade com função antiga
    reorderSubtasks: async function (draggingTaskId, targetTaskId) {
        await this.reorderTasks(draggingTaskId, targetTaskId, 'before');
    },

    // --- NOVO: SISTEMA DE NOTIFICAÇÕES ---

    // Função para atualizar a UI das notificações
    updateNotificationUI: function () {
        const badge = document.getElementById('notification-badge');
        const notificationList = document.getElementById('notification-list');
        const unreadCount = dataService.getUnreadNotificationCount();

        // Atualizar badge
        if (unreadCount > 0) {
            badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }

        // Atualizar lista de notificações
        if (dataService.notifications.length === 0) {
            notificationList.innerHTML = `
                <div class="notification-empty">
                    <p>Nenhuma notificação</p>
                    <p class="text-sm mt-2">Você será notificado quando houver novas atividades</p>
                </div>
            `;
        } else {
            notificationList.innerHTML = dataService.notifications.map(notification => {
                const timeAgo = this.getTimeAgo(notification.createdAt);
                const icon = this.getNotificationIcon(notification.type);
                const projectBadge = notification.projectName ?
                    `<span class="notification-project">${notification.projectName}</span>` : '';

                return `
                    <div class="notification-item ${notification.read ? 'read' : 'unread'}" data-id="${notification.id}">
                        <div class="notification-title">
                            ${icon}
                            ${notification.title}
                            ${projectBadge}
                        </div>
                        <div class="notification-message">${notification.message}</div>
                        <div class="notification-time">${timeAgo}</div>
                    </div>
                `;
            }).join('');

            // Adicionar event listeners para as notificações
            notificationList.querySelectorAll('.notification-item').forEach(item => {
                item.addEventListener('click', () => {
                    const notificationId = item.dataset.id;
                    this.handleNotificationClick(notificationId, item);
                });
            });
        }
    },

    // Função para obter o ícone da notificação baseado no tipo
    getNotificationIcon: function (type) {
        const icons = {
            'task_assignment': '📋',
            'project_update': '📁',
            'deadline': '⏰',
            'comment': '💬',
            'mention': '👤',
            'system': '🔔'
        };

        return `<span class="notification-icon">${icons[type] || '🔔'}</span>`;
    },

    // Função para calcular tempo relativo
    getTimeAgo: function (dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Agora mesmo';
        if (diffMins < 60) return `${diffMins} min atrás`;
        if (diffHours < 24) return `${diffHours} h atrás`;
        if (diffDays < 7) return `${diffDays} dias atrás`;

        return date.toLocaleDateString('pt-BR');
    },

    // Função para lidar com clique em notificação
    handleNotificationClick: function (notificationId, element) {
        const notification = dataService.notifications.find(n => n.id === notificationId);
        if (!notification) return;

        // Marcar como lida
        if (!notification.read) {
            dataService.markNotificationAsRead(notificationId);
            element.classList.remove('unread');
            element.classList.add('read');
        }

        // Fechar dropdown
        this.hideNotificationDropdown();

        // Navegar para o projeto/tarefa se aplicável
        if (notification.projectId && dataService.currentProjectId !== notification.projectId) {
            App.openProject(notification.projectId);
        }

        // Mostrar toast de confirmação
        uiService.showToast('Notificação marcada como lida', 'success');
    },

    // Função para alternar visibilidade do dropdown de notificações
    toggleNotificationDropdown: function () {
        if (this.notificationDropdownVisible) {
            this.hideNotificationDropdown();
        } else {
            this.showNotificationDropdown();
        }
    },

    // Função para mostrar dropdown de notificações
    showNotificationDropdown: function () {
        const dropdown = document.getElementById('notification-dropdown');
        dropdown.classList.add('show');
        this.notificationDropdownVisible = true;

        // Adicionar event listener para fechar ao clicar fora
        setTimeout(() => {
            document.addEventListener('click', this.handleClickOutsideNotifications);
        }, 10);
    },

    // Função para esconder dropdown de notificações
    hideNotificationDropdown: function () {
        const dropdown = document.getElementById('notification-dropdown');
        dropdown.classList.remove('show');
        this.notificationDropdownVisible = false;

        // Remover event listener
        document.removeEventListener('click', this.handleClickOutsideNotifications);
    },

    // Função para lidar com clique fora do dropdown de notificações
    handleClickOutsideNotifications: function (event) {
        const notificationBell = document.querySelector('.notification-bell');
        const dropdown = document.getElementById('notification-dropdown');

        if (!notificationBell.contains(event.target) && !dropdown.contains(event.target)) {
            uiService.hideNotificationDropdown();
        }
    },

    // --- SISTEMA DE ALERTAS/LEMBRETES ---

    // Flag para controlar se os alertas já foram mostrados nesta sessão
    alertsShownThisSession: false,

    // Função para mostrar alertas ao fazer login
    showLoginAlerts: function () {
        // Só mostrar alertas uma vez por sessão
        if (this.alertsShownThisSession) return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const overdueTasks = [];
        const todayTasks = [];

        // Percorrer todos os projetos e suas tarefas
        dataService.projects.forEach(project => {
            if (!project.tasks) return;

            project.tasks.forEach(task => {
                // Verificar se o usuário está atribuído a esta tarefa
                const isAssigned = task.assignedUsers && task.assignedUsers.includes(dataService.userId);
                const isGestor = dataService.userRole === 'Gestor';

                // Só mostrar tarefas se for gestor ou se estiver atribuído
                if (!isGestor && !isAssigned) return;

                // Ignorar tarefas concluídas
                if (task.status === 'Concluída') return;

                const taskDates = dataService.getLatestDates(task);
                const endDate = new Date(taskDates.endDate);
                endDate.setHours(0, 0, 0, 0);
                const startDate = new Date(taskDates.startDate);
                startDate.setHours(0, 0, 0, 0);

                // Verificar se está atrasada
                if (endDate < today) {
                    overdueTasks.push({
                        ...task,
                        projectName: project.name,
                        projectId: project.id,
                        endDate: taskDates.endDate
                    });
                }
                // Verificar se é tarefa de hoje (em execução hoje)
                else if (startDate <= today && endDate >= today) {
                    todayTasks.push({
                        ...task,
                        projectName: project.name,
                        projectId: project.id,
                        startDate: taskDates.startDate,
                        endDate: taskDates.endDate
                    });
                }
            });
        });

        // Se não houver alertas, não mostrar o modal
        if (overdueTasks.length === 0 && todayTasks.length === 0) {
            this.alertsShownThisSession = true;
            return;
        }

        // Atualizar a data no modal
        const todayStr = today.toLocaleDateString('pt-BR', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        document.getElementById('alerts-date').textContent = todayStr.charAt(0).toUpperCase() + todayStr.slice(1);

        // Função auxiliar para obter nome do dono do projeto
        const getProjectOwnerName = (projectId) => {
            const project = dataService.projects.find(p => p.id === projectId);
            if (!project || !project.creatorId) return null;
            const owner = dataService.users.find(u => u.id === project.creatorId);
            return owner ? owner.name : null;
        };

        const isGestor = dataService.userRole === 'Gestor';

        // Renderizar tarefas atrasadas
        const overdueSection = document.getElementById('alerts-overdue-section');
        const overdueList = document.getElementById('alerts-overdue-list');
        const overdueCount = document.getElementById('alerts-overdue-count');

        if (overdueTasks.length > 0) {
            overdueSection.classList.remove('hidden');
            overdueCount.textContent = overdueTasks.length;
            overdueList.innerHTML = overdueTasks.map(task => {
                const daysOverdue = Math.ceil((today - new Date(task.endDate)) / (1000 * 60 * 60 * 24));
                const ownerName = isGestor ? getProjectOwnerName(task.projectId) : null;
                const ownerInfo = ownerName ? `<div class="alert-task-owner" style="font-size: 11px; color: #6b7280; margin-top: 2px;">👤 Responsável: ${ownerName}</div>` : '';
                return `
                    <div class="alert-task-item overdue" data-project-id="${task.projectId}">
                        <span class="alert-task-project">${task.projectName}</span>
                        ${ownerInfo}
                        <div class="alert-task-name">${task.name}</div>
                        <div class="alert-task-date overdue-date">
                            Vencida há ${daysOverdue} dia(s) - ${new Date(task.endDate).toLocaleDateString('pt-BR')}
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            overdueSection.classList.add('hidden');
        }

        // Renderizar tarefas de hoje
        const todaySection = document.getElementById('alerts-today-section');
        const todayList = document.getElementById('alerts-today-list');
        const todayCount = document.getElementById('alerts-today-count');

        if (todayTasks.length > 0) {
            todaySection.classList.remove('hidden');
            todayCount.textContent = todayTasks.length;
            todayList.innerHTML = todayTasks.map(task => {
                const ownerName = isGestor ? getProjectOwnerName(task.projectId) : null;
                const ownerInfo = ownerName ? `<div class="alert-task-owner" style="font-size: 11px; color: #6b7280; margin-top: 2px;">👤 Responsável: ${ownerName}</div>` : '';
                return `
                    <div class="alert-task-item today" data-project-id="${task.projectId}">
                        <span class="alert-task-project">${task.projectName}</span>
                        ${ownerInfo}
                        <div class="alert-task-name">${task.name}</div>
                        <div class="alert-task-date">
                            ${new Date(task.startDate).toLocaleDateString('pt-BR')} a ${new Date(task.endDate).toLocaleDateString('pt-BR')}
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            todaySection.classList.add('hidden');
        }

        // Mostrar seção vazia se necessário
        const emptySection = document.getElementById('alerts-empty');
        if (overdueTasks.length === 0 && todayTasks.length === 0) {
            emptySection.classList.remove('hidden');
        } else {
            emptySection.classList.add('hidden');
        }

        // Mostrar o modal
        this.openModal('alerts-modal');
        this.alertsShownThisSession = true;

        // Adicionar event listeners para os itens de tarefa
        document.querySelectorAll('#alerts-modal .alert-task-item').forEach(item => {
            item.addEventListener('click', () => {
                const projectId = item.dataset.projectId;
                this.closeModal('alerts-modal');
                App.openProject(projectId);
            });
            item.style.cursor = 'pointer';
        });
    },

    // --- NOVO: SISTEMA DE ANEXOS ---

    // Função para lidar com upload de arquivos
    handleFileUpload: async function (files) {
        if (!files || files.length === 0) return;

        const taskId = document.getElementById('task-id').value;
        const projectId = dataService.currentProjectId;

        if (!taskId) {
            uiService.showToast('Salve a tarefa antes de adicionar anexos.', 'error');
            return;
        }

        document.getElementById('loader').style.display = 'flex';

        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];

                // Verificar tamanho do arquivo (limite de 10MB)
                if (file.size > 10 * 1024 * 1024) {
                    uiService.showToast(`Arquivo ${file.name} é muito grande (máximo 10MB)`, 'error');
                    continue;
                }

                // Fazer upload do arquivo
                const attachment = await dataService.uploadAttachment(file, taskId, projectId);

                // Adicionar à lista de anexos na UI
                this.addAttachmentToUI(attachment);

                uiService.showToast(`Arquivo ${file.name} adicionado com sucesso!`, 'success');
            }
        } catch (error) {
            console.error('Erro ao fazer upload de arquivos:', error);
            uiService.showToast('Erro ao fazer upload dos arquivos', 'error');
        } finally {
            document.getElementById('loader').style.display = 'none';
            document.getElementById('file-upload').value = '';
        }
    },

    // Função para adicionar anexo à UI
    addAttachmentToUI: function (attachment) {
        const container = document.getElementById('attachments-container');

        const attachmentItem = document.createElement('div');
        attachmentItem.className = 'attachment-item';
        attachmentItem.dataset.fileName = attachment.name;

        const fileIcon = dataService.getFileIcon(attachment.name);
        const fileSize = this.formatFileSize(attachment.size);

        attachmentItem.innerHTML = `
            <div class="attachment-info">
                <span class="attachment-icon">${fileIcon}</span>
                <span class="attachment-name" title="${attachment.name}">${attachment.name}</span>
                <span class="text-xs text-gray-500">(${fileSize})</span>
            </div>
            <div class="attachment-actions">
                <a href="${attachment.url}" target="_blank" class="attachment-btn attachment-download" download="${attachment.name}">
                    Baixar
                </a>
                <button class="attachment-btn attachment-delete" data-file-name="${attachment.name}">
                    Excluir
                </button>
            </div>
        `;

        container.appendChild(attachmentItem);

        // Adicionar event listener para o botão de exclusão
        attachmentItem.querySelector('.attachment-delete').addEventListener('click', async (e) => {
            const fileName = e.target.dataset.fileName;
            await this.deleteAttachment(fileName);
        });
    },

    // Função para excluir anexo
    deleteAttachment: async function (fileName) {
        const taskId = document.getElementById('task-id').value;
        const projectId = dataService.currentProjectId;

        if (!taskId) {
            uiService.showToast('Erro: ID da tarefa não encontrado', 'error');
            return;
        }

        const confirmed = await this.showConfirmModalPromise(`Excluir o arquivo ${fileName}?`);

        if (confirmed) {
            document.getElementById('loader').style.display = 'flex';

            try {
                await dataService.deleteAttachment(fileName, taskId, projectId);

                // Remover da UI
                const attachmentItem = document.querySelector(`.attachment-item[data-file-name="${fileName}"]`);
                if (attachmentItem) {
                    attachmentItem.remove();
                }

                uiService.showToast('Arquivo excluído com sucesso!', 'success');
            } catch (error) {
                console.error('Erro ao excluir arquivo:', error);
                uiService.showToast('Erro ao excluir arquivo', 'error');
            } finally {
                document.getElementById('loader').style.display = 'none';
            }
        }
    },

    // Função para formatar tamanho do arquivo
    formatFileSize: function (bytes) {
        if (bytes === 0) return '0 Bytes';

        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },

    // Função para renderizar anexos existentes
    renderAttachments: function (attachments) {
        const container = document.getElementById('attachments-container');
        container.innerHTML = '';

        if (!attachments || attachments.length === 0) {
            container.innerHTML = '<div class="text-center text-gray-500 py-4">Nenhum arquivo anexado</div>';
            return;
        }

        attachments.forEach(attachment => {
            this.addAttachmentToUI(attachment);
        });
    },

    // --- NOVO: SISTEMA DE MENÇÕES ---

    // Função para lidar com input de menções
    handleMentionInput: function (e) {
        const input = e.target;
        const value = input.value;
        const cursorPosition = input.selectionStart;

        // Verificar se o usuário está digitando uma menção (@)
        const lastAtSymbol = value.lastIndexOf('@', cursorPosition - 1);

        if (lastAtSymbol !== -1) {
            // Encontrar o texto após o @
            const textAfterAt = value.substring(lastAtSymbol + 1, cursorPosition);

            // Se não há espaço após o @, mostrar sugestões
            if (!textAfterAt.includes(' ')) {
                this.showMentionSuggestions(textAfterAt, lastAtSymbol, input);
                return;
            }
        }

        // Esconder sugestões se não está digitando uma menção
        this.hideMentionSuggestions();
    },

    // Função para mostrar sugestões de menção
    showMentionSuggestions: function (searchText, mentionStart, input) {
        const suggestionsContainer = document.getElementById('mention-suggestions');
        suggestionsContainer.innerHTML = '';

        // Filtrar usuários baseado no texto de busca
        const filteredUsers = dataService.users.filter(user =>
            user.name?.toLowerCase().includes(searchText.toLowerCase()) ||
            user.email.toLowerCase().includes(searchText.toLowerCase())
        );

        if (filteredUsers.length === 0) {
            this.hideMentionSuggestions();
            return;
        }


        // Adicionar sugestões ao container
        filteredUsers.forEach((user, index) => {
            const suggestion = document.createElement('div');
            suggestion.className = 'mention-suggestion';
            suggestion.dataset.userId = user.id;
            suggestion.dataset.userName = user.name || user.email.split('@')[0];

            if (index === 0) {
                suggestion.classList.add('active');
            }

            suggestion.innerHTML = `
                <strong>${user.name || user.email.split('@')[0]}</strong>
                <span class="text-xs text-gray-500">${user.email}</span>
            `;

            suggestion.addEventListener('click', () => {
                this.selectMention(user, mentionStart, input);
            });

            suggestionsContainer.appendChild(suggestion);
        });

        // Posicionar o container de sugestões
        this.positionMentionSuggestions(input, suggestionsContainer);
        suggestionsContainer.style.display = 'block';
        this.mentionSuggestionsVisible = true;
        this.currentMentionStart = mentionStart;
    },

    // Função para posicionar o container de sugestões
    positionMentionSuggestions: function (input, suggestionsContainer) {
        // Como o container está dentro do mesmo parent com position: relative,
        // usamos posição relativa ao parent (100% = logo abaixo do input)
        suggestionsContainer.style.top = '100%';
        suggestionsContainer.style.left = '0';
        suggestionsContainer.style.width = `${input.offsetWidth}px`;
    },

    // Função para esconder sugestões de menção
    hideMentionSuggestions: function () {
        const suggestionsContainer = document.getElementById('mention-suggestions');
        suggestionsContainer.style.display = 'none';
        suggestionsContainer.innerHTML = '';
        this.mentionSuggestionsVisible = false;
        this.currentMentionStart = -1;
    },

    // Função para lidar com teclas no input de menções
    handleMentionKeydown: function (e) {
        if (!this.mentionSuggestionsVisible) return;

        const suggestionsContainer = document.getElementById('mention-suggestions');
        const activeSuggestion = suggestionsContainer.querySelector('.mention-suggestion.active');
        const suggestions = suggestionsContainer.querySelectorAll('.mention-suggestion');

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.selectNextSuggestion(suggestions, activeSuggestion);
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.selectPreviousSuggestion(suggestions, activeSuggestion);
                break;
            case 'Enter':
                e.preventDefault();
                if (activeSuggestion) {
                    const userId = activeSuggestion.dataset.userId;
                    const userName = activeSuggestion.dataset.userName;
                    const user = dataService.users.find(u => u.id === userId);
                    if (user) {
                        this.selectMention(user, this.currentMentionStart, e.target);
                    }
                }
                break;
            case 'Escape':
                e.preventDefault();
                this.hideMentionSuggestions();
                break;
        }
    },

    // Função para selecionar próxima sugestão
    selectNextSuggestion: function (suggestions, activeSuggestion) {
        const currentIndex = Array.from(suggestions).indexOf(activeSuggestion);
        const nextIndex = (currentIndex + 1) % suggestions.length;

        activeSuggestion.classList.remove('active');
        suggestions[nextIndex].classList.add('active');
    },

    // Função para selecionar sugestão anterior
    selectPreviousSuggestion: function (suggestions, activeSuggestion) {
        const currentIndex = Array.from(suggestions).indexOf(activeSuggestion);
        const prevIndex = (currentIndex - 1 + suggestions.length) % suggestions.length;

        activeSuggestion.classList.remove('active');
        suggestions[prevIndex].classList.add('active');
    },

    // Função para selecionar uma menção
    selectMention: function (user, mentionStart, input) {
        const value = input.value;
        const userName = user.name || user.email.split('@')[0];

        // Exibir apenas @Nome no input (mais amigável ao usuário)
        const displayMention = `@${userName}`;
        const newValue = value.substring(0, mentionStart) +
            displayMention +
            value.substring(input.selectionStart);

        input.value = newValue;

        // Armazenar o usuário à lista de mencionados (com nome e ID para reconstruir depois)
        this.mentionedUsers.push({
            id: user.id,
            name: userName,
            displayText: displayMention
        });

        // Esconder sugestões
        this.hideMentionSuggestions();

        // Focar no input novamente
        input.focus();

        // Posicionar o cursor após a menção
        const newCursorPosition = mentionStart + displayMention.length;
        input.setSelectionRange(newCursorPosition, newCursorPosition);
    },

    // Função para processar menções em comentários
    processMentionsInComment: async function (commentText, taskId, taskName, projectId, projectName) {
        // Extrair menções do formato [Nome](ID)
        const mentionRegex = /@\[([^\]]+)\]\(([^)]+)\)/g;
        let match;
        const mentionedUserIds = [];

        while ((match = mentionRegex.exec(commentText)) !== null) {
            const userId = match[2];
            mentionedUserIds.push(userId);
        }

        // Enviar notificações para usuários mencionados
        for (const userId of mentionedUserIds) {
            await dataService.sendMentionNotification(userId, taskId, taskName, projectId, projectName, commentText);
        }

        return mentionedUserIds;
    },

    // --- NOVO: SISTEMA DE ATIVIDADE ---

    // Função para alternar entre abas
    switchTab: function (tabName) {
        // Atualizar abas
        document.querySelectorAll('.tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === tabName);
        });

        // Atualizar conteúdo
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.toggle('active', content.id === `${tabName}-tab`);
        });

        // Se for a aba de atividade, carregar o histórico
        if (tabName === 'activity') {
            this.loadActivityHistory();
        }
    },

    // Função para carregar histórico de atividade
    loadActivityHistory: async function () {
        const taskId = document.getElementById('task-id').value;
        const projectId = dataService.currentProjectId;

        if (!taskId) return;

        document.getElementById('loader').style.display = 'flex';

        try {
            const activities = await dataService.getActivityHistory(taskId, projectId);
            this.renderActivityHistory(activities);
        } catch (error) {
            console.error('Erro ao carregar histórico de atividade:', error);
            uiService.showToast('Erro ao carregar histórico de atividade', 'error');
        } finally {
            document.getElementById('loader').style.display = 'none';
        }
    },

    // Função para renderizar histórico de atividade
    renderActivityHistory: function (activities) {
        const container = document.getElementById('activity-list');

        if (!activities || activities.length === 0) {
            container.innerHTML = '<div class="text-center text-gray-500 py-4">Nenhuma atividade registrada</div>';
            return;
        }

        container.innerHTML = activities.map(activity => {
            const time = new Date(activity.timestamp).toLocaleString('pt-BR');
            let actionText = '';

            switch (activity.action) {
                case 'created':
                    actionText = `criou a tarefa`;
                    break;
                case 'updated':
                    actionText = `alterou ${activity.details}`;
                    if (activity.oldValue && activity.newValue) {
                        actionText += ` de "${activity.oldValue}" para "${activity.newValue}"`;
                    }
                    break;
                case 'commented':
                    actionText = `comentou: "${activity.details}"`;
                    break;
                case 'attachment_added':
                    actionText = `adicionou o anexo "${activity.details}"`;
                    break;
                case 'attachment_deleted':
                    actionText = `removeu o anexo "${activity.details}"`;
                    break;
                default:
                    actionText = activity.details;
            }

            return `
                <div class="activity-item">
                    <div class="font-medium">${activity.userName}</div>
                    <div>${actionText}</div>
                    <div class="activity-time">${time}</div>
                </div>
            `;
        }).join('');
    },

    // --- VIEW/MODAL MANAGEMENT ---
    showView(viewId) {
        document.getElementById('project-view').classList.add('hidden');
        document.getElementById('dashboard-view').classList.add('hidden');
        document.getElementById(viewId).classList.remove('hidden');
    },
    switchView(viewName) {
        document.getElementById('table-view').classList.toggle('hidden', viewName === 'gantt');
        document.getElementById('gantt-view').classList.toggle('hidden', viewName === 'table');
        if (viewName === 'gantt') this.renderGanttChart(dataService.getCurrentProject().tasks, document.getElementById('task-filter-input').value);
    },
    renderProjectDashboard(project, filter = '') {
        const filteredTasks = project.tasks.filter(t =>
            t.name.toLowerCase().includes(filter.toLowerCase()) ||
            (t.assignedUsers && t.assignedUsers.some(uid => {
                const user = dataService.users.find(u => u.id === uid);
                return user && user.email.toLowerCase().includes(filter.toLowerCase());
            }))
        );

        document.getElementById('project-title').textContent = project.name;

        // Atualizar visibilidade dos botões de finalizar/reabrir
        const progress = dataService.getProjectProgress(project.tasks);
        const finalizeBtn = document.getElementById('finalize-project-btn');
        const reopenBtn = document.getElementById('reopen-project-btn');

        if (project.finalized) {
            // Projeto já finalizado: mostrar botão de reabrir
            finalizeBtn.classList.add('hidden');
            reopenBtn.classList.remove('hidden');
        } else if (progress === 100) {
            // Projeto 100% completo: mostrar botão de finalizar
            finalizeBtn.classList.remove('hidden');
            reopenBtn.classList.add('hidden');
        } else {
            // Projeto não completo: esconder ambos
            finalizeBtn.classList.add('hidden');
            reopenBtn.classList.add('hidden');
        }

        // NOVO: Atualizar exibição das datas do projeto
        this.updateProjectDatesDisplay(project);

        this.renderTaskTable(filteredTasks);
        this.updateKpis(project.tasks);
        this.renderAssigneeSummary(project.tasks);
        if (document.getElementById('view-switcher').value === 'gantt') {
            this.renderGanttChart(filteredTasks);
        }
    },

    // NOVA FUNÇÃO: Atualizar exibição das datas do projeto
    updateProjectDatesDisplay: function (project) {
        const startDateEl = document.getElementById('project-start-date-display');
        const endDateEl = document.getElementById('project-end-date-display');
        const autoBadge = document.getElementById('project-date-auto');
        const manualBadge = document.getElementById('project-date-manual');

        if (project.startDate && project.endDate) {
            startDateEl.textContent = new Date(project.startDate).toLocaleDateString('pt-BR');
            endDateEl.textContent = new Date(project.endDate).toLocaleDateString('pt-BR');

            // Mostrar badge apropriado baseado no modo
            if (project.dateMode === 'auto') {
                autoBadge.classList.remove('hidden');
                manualBadge.classList.add('hidden');
            } else {
                autoBadge.classList.add('hidden');
                manualBadge.classList.remove('hidden');
            }
        } else {
            startDateEl.textContent = 'Não definida';
            endDateEl.textContent = 'Não definida';
            autoBadge.classList.add('hidden');
            manualBadge.classList.add('hidden');
        }
    },

    openModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.classList.remove('modal-hidden');
        modal.classList.add('modal-visible');
    },
    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.classList.remove('modal-visible');
        modal.classList.add('modal-hidden');
    },
    closeAllModals() {
        document.querySelectorAll('.modal-transition').forEach(modal => this.closeModal(modal.id));
    },

    // FUNÇÃO openTaskModal ATUALIZADA para o novo layout com anexos e atividade
    openTaskModal(mode, data = {}) {
        document.getElementById('task-form').reset();
        this.populateAssignedUsersCheckboxes();
        this.populateParentTaskSelect(data.taskId);
        this.hideMentionSuggestions();
        this.mentionedUsers = [];

        // Limpar busca de usuários
        const userSearchInput = document.getElementById('user-search-input');
        if (userSearchInput) userSearchInput.value = '';

        const { parentId, taskId } = data;
        const project = dataService.getCurrentProject();
        const task = taskId ? project.tasks.find(t => t.id === taskId) : {};
        const isParent = taskId ? project.tasks.some(t => t.parentId === taskId) : false;

        // Preencher checkboxes de usuários atribuídos
        if (mode === 'edit') {
            const assignedUsers = task.assignedUsers || [];
            document.querySelectorAll('.user-checkbox').forEach(checkbox => {
                checkbox.checked = assignedUsers.includes(checkbox.value);
            });
        } else {
            document.querySelectorAll('.user-checkbox').forEach(checkbox => {
                checkbox.checked = false;
            });
        }

        // Atualizar badges de usuários selecionados
        this.updateSelectedUsersBadges();

        // Preencher select de tarefa pai
        const parentSelect = document.getElementById('task-parent-select');
        if (parentSelect) {
            if (parentId) {
                parentSelect.value = parentId;
            } else if (task && task.parentId) {
                parentSelect.value = task.parentId;
            } else {
                parentSelect.value = '';
            }
        }

        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');
        const rescheduleBtnContainer = document.getElementById('reschedule-button-container');
        const dateHistoryContainer = document.getElementById('date-history-container');
        const dateHistoryList = document.getElementById('date-history-list');

        document.getElementById('progress-info').classList.toggle('hidden', !isParent);
        document.getElementById('task-progress').disabled = isParent;
        document.getElementById('task-progress-range').disabled = isParent;

        document.getElementById('modal-title').textContent = mode === 'add' ? 'Adicionar Tarefa' : 'Editar Tarefa';
        document.getElementById('task-id').value = task.id || '';
        document.getElementById('parent-id').value = parentId || (task ? task.parentId : '') || '';
        document.getElementById('task-name').value = task.name || '';
        document.getElementById('task-priority').value = task.priority || 'Média';
        document.getElementById('task-status').value = task.status || 'Não Iniciada';
        document.getElementById('task-progress').value = task.progress || 0;
        document.getElementById('task-progress-range').value = task.progress || 0;
        document.getElementById('task-risk').checked = task.risk || false;

        const dependencySelect = document.getElementById('task-dependency');
        dependencySelect.innerHTML = '<option value="">Nenhuma</option>';
        project?.tasks.forEach(t => {
            if (t.id !== task.id) {
                const option = document.createElement('option');
                option.value = t.id;
                option.textContent = t.name;
                dependencySelect.appendChild(option);
            }
        });
        dependencySelect.value = task.dependsOn || '';

        this.renderComments(task.comments || []);
        document.getElementById('new-comment-input').value = '';

        // NOVO: Renderizar anexos
        this.renderAttachments(task.attachments || []);

        // NOVO: Resetar aba para comentários
        this.switchTab('comments');

        if (mode === 'edit') {
            const latestDates = dataService.getLatestDates(task);
            startDateInput.value = latestDates.startDate;
            endDateInput.value = latestDates.endDate;
            startDateInput.disabled = true;
            endDateInput.disabled = true;
            rescheduleBtnContainer.classList.remove('hidden');
            dateHistoryContainer.classList.remove('hidden');

            dateHistoryList.innerHTML = (task.dateHistory || []).map((d, i) =>
                `<p>${i + 1}: ${new Date(d.startDate + 'T00:00:00').toLocaleDateString('pt-BR')} - ${new Date(d.endDate + 'T00:00:00').toLocaleDateString('pt-BR')}</p>`
            ).join('');

            const rescheduleHandler = () => {
                startDateInput.disabled = false;
                endDateInput.disabled = false;
                document.getElementById('reschedule-btn').classList.add('hidden');
            };

            document.getElementById('reschedule-btn').classList.remove('hidden');
            document.getElementById('reschedule-btn').onclick = rescheduleHandler;

        } else {
            startDateInput.disabled = false;
            endDateInput.disabled = false;
            startDateInput.value = '';
            endDateInput.value = '';
            rescheduleBtnContainer.classList.add('hidden');
            dateHistoryContainer.classList.add('hidden');
        }

        this.openModal('task-modal');
    },

    getTaskFormData() {
        const startDateInput = document.getElementById('start-date');
        const endDateInput = document.getElementById('end-date');

        // Coletar usuários selecionados
        const selectedUsers = Array.from(document.querySelectorAll('.user-checkbox:checked'))
            .map(checkbox => checkbox.value)
            .filter(uid => uid);

        const commentsList = document.getElementById('comments-list');
        const comments = Array.from(commentsList.querySelectorAll('.comment-item')).map(item => ({
            id: item.dataset.commentId,
            text: item.dataset.text,
            timestamp: item.dataset.timestamp,
            author: item.dataset.author
        }));

        // NOVO: Coletar anexos
        const attachmentsContainer = document.getElementById('attachments-container');
        const attachments = Array.from(attachmentsContainer.querySelectorAll('.attachment-item')).map(item => ({
            name: item.dataset.fileName,
            // Outras informações dos anexos seriam coletadas de um data attribute
        }));

        // Obter parentId do select ou do campo hidden
        const parentSelect = document.getElementById('task-parent-select');
        const parentIdHidden = document.getElementById('parent-id');
        let parentId = null;

        if (parentSelect && parentSelect.value) {
            parentId = parseFloat(parentSelect.value);
        } else if (parentIdHidden && parentIdHidden.value) {
            parentId = parseFloat(parentIdHidden.value);
        }

        const data = {
            id: document.getElementById('task-id').value ? parseFloat(document.getElementById('task-id').value) : null,
            parentId: parentId,
            name: document.getElementById('task-name').value,
            assignedUsers: selectedUsers,
            priority: document.getElementById('task-priority').value,
            status: document.getElementById('task-status').value,
            progress: parseInt(document.getElementById('task-progress').value),
            risk: document.getElementById('task-risk').checked,
            dependsOn: document.getElementById('task-dependency').value ? parseFloat(document.getElementById('task-dependency').value) : null, // CORREÇÃO: Usar parseFloat
            comments: comments,
            attachments: attachments, // NOVO: Incluir anexos
            newStartDate: startDateInput.value,
            newEndDate: endDateInput.value,
        };
        return data;
    },

    showConfirmModal(body, onConfirm) {
        document.getElementById('confirm-modal-body').textContent = body;
        this.openModal('confirm-modal');
        const confirmBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');

        const newConfirmBtn = confirmBtn.cloneNode(true);
        const newCancelBtn = cancelBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

        newConfirmBtn.addEventListener('click', () => { onConfirm(); this.closeModal('confirm-modal'); });
        newCancelBtn.addEventListener('click', () => { this.closeModal('confirm-modal'); });
    },

    // MELHORIA: Função melhorada para renderizar comentários com autor
    renderComments: function (comments) {
        const listEl = document.getElementById('comments-list');
        listEl.innerHTML = '';

        // Ordenar comentários do mais recente para o mais antigo
        comments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .forEach(comment => {
                const commentItem = document.createElement('div');
                commentItem.className = "comment-item border-b border-[var(--border-color)] pb-1 mb-1 text-xs last:border-b-0 relative";
                commentItem.dataset.commentId = comment.id || Date.now() + Math.random();
                commentItem.dataset.timestamp = comment.timestamp;
                commentItem.dataset.text = comment.text;
                commentItem.dataset.author = comment.author || dataService.users.find(u => u.id === dataService.userId)?.name || 'Utilizador';

                const dateString = new Date(comment.timestamp).toLocaleDateString('pt-BR');
                const timeString = new Date(comment.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

                commentItem.innerHTML = `
                <div class="flex justify-between items-start">
                    <div class="flex-1">
                        <div class="flex items-center gap-2 mb-1">
                            <span class="font-semibold text-gray-500">${commentItem.dataset.author}</span>
                            <span class="text-gray-400 text-xs">${dateString} ${timeString}</span>
                        </div>
                        <span class="comment-text">${comment.text}</span>
                    </div>
                    <div class="comment-actions flex gap-1 ml-2">
                        <button class="edit-comment-btn text-blue-500 hover:text-blue-700" title="Editar comentário">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                            </svg>
                        </button>
                        <button class="delete-comment-btn text-red-500 hover:text-red-700" title="Excluir comentário">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                                <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 000-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                            </svg>
                        </button>
                    </div>
                </div>
            `;
                listEl.appendChild(commentItem);
            });

        // Adicionar event listeners para os botões de edição e exclusão
        listEl.querySelectorAll('.edit-comment-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const commentItem = e.target.closest('.comment-item');
                this.editComment(commentItem);
            });
        });

        listEl.querySelectorAll('.delete-comment-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const commentItem = e.target.closest('.comment-item');
                this.deleteComment(commentItem);
            });
        });
    },

    // MELHORIA: Função para editar comentário
    editComment: function (commentItem) {
        const commentText = commentItem.querySelector('.comment-text');
        const currentText = commentText.textContent;

        // Criar input de edição
        const editInput = document.createElement('input');
        editInput.type = 'text';
        editInput.className = 'edit-comment-input';
        editInput.value = currentText;

        // Substituir texto pelo input
        commentText.replaceWith(editInput);
        editInput.focus();

        // Adicionar botões de confirmação/cancelamento
        const actionButtons = commentItem.querySelector('.comment-actions');
        actionButtons.innerHTML = `
            <button class="save-comment-btn text-green-500 hover:text-green-700" title="Salvar">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                </svg>
            </button>
            <button class="cancel-edit-comment-btn text-gray-500 hover:text-gray-700" title="Cancelar">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                </svg>
            </button>
        `;

        // Event listeners para os novos botões
        commentItem.querySelector('.save-comment-btn').addEventListener('click', () => {
            const newText = editInput.value.trim();
            if (newText) {
                commentItem.dataset.text = newText;
                const newCommentText = document.createElement('span');
                newCommentText.className = 'comment-text';
                newCommentText.textContent = newText;
                editInput.replaceWith(newCommentText);
                this.restoreCommentButtons(commentItem);
            }
        });

        commentItem.querySelector('.cancel-edit-comment-btn').addEventListener('click', () => {
            const originalCommentText = document.createElement('span');
            originalCommentText.className = 'comment-text';
            originalCommentText.textContent = currentText;
            editInput.replaceWith(originalCommentText);
            this.restoreCommentButtons(commentItem);
        });

        // Salvar ao pressionar Enter
        editInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                commentItem.querySelector('.save-comment-btn').click();
            }
        });
    },

    // MELHORIA: Restaurar botões padrão do comentário
    restoreCommentButtons: function (commentItem) {
        const actionButtons = commentItem.querySelector('.comment-actions');
        actionButtons.innerHTML = `
            <button class="edit-comment-btn text-blue-500 hover:text-blue-700" title="Editar comentário">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                </svg>
            </button>
            <button class="delete-comment-btn text-red-500 hover:text-red-700" title="Excluir comentário">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 000-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                </svg>
            </button>
        `;

        // Re-adicionar event listeners
        actionButtons.querySelector('.edit-comment-btn').addEventListener('click', (e) => {
            this.editComment(commentItem);
        });
        actionButtons.querySelector('.delete-comment-btn').addEventListener('click', (e) => {
            this.deleteComment(commentItem);
        });
    },

    // MELHORIA: Função para excluir comentário
    deleteComment: function (commentItem) {
        commentItem.remove();
    },

    // MELHORIA: Função para adicionar comentário (atualizada com autor e menções)
    addComment: async function (text) {
        if (!text.trim()) return;

        const listEl = document.getElementById('comments-list');
        const commentItem = document.createElement('div');
        const commentId = Date.now() + Math.random();
        const timestamp = new Date().toISOString();
        const currentUser = dataService.users.find(u => u.id === dataService.userId);
        const authorName = currentUser?.name || currentUser?.email.split('@')[0] || 'Utilizador';

        // NOVO: Processar menções no comentário
        const taskId = document.getElementById('task-id').value;
        const taskName = document.getElementById('task-name').value;
        const projectId = dataService.currentProjectId;
        const project = dataService.getCurrentProject();
        const projectName = project ? project.name : '';

        // Reconstruir o formato interno das menções (@Nome → @[Nome](ID))
        let internalText = text;
        if (this.mentionedUsers && this.mentionedUsers.length > 0) {
            for (const mention of this.mentionedUsers) {
                // Substituir @Nome por @[Nome](ID) para processamento interno
                const displayPattern = mention.displayText || `@${mention.name}`;
                const internalFormat = `@[${mention.name}](${mention.id})`;
                internalText = internalText.replace(displayPattern, internalFormat);
            }
        }

        if (taskId && projectId) {
            // Enviar notificações de menção usando os IDs armazenados
            for (const mention of (this.mentionedUsers || [])) {
                const mentionUserId = typeof mention === 'object' ? mention.id : mention;
                await dataService.sendMentionNotification(mentionUserId, taskId, taskName, projectId, projectName, internalText);
            }
        }

        commentItem.className = "comment-item border-b border-[var(--border-color)] pb-1 mb-1 text-xs last:border-b-0 relative";
        commentItem.dataset.commentId = commentId;
        commentItem.dataset.timestamp = timestamp;
        commentItem.dataset.text = internalText; // Usar formato interno para salvar
        commentItem.dataset.author = authorName;

        const dateString = new Date(timestamp).toLocaleDateString('pt-BR');
        const timeString = new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        // NOVO: Processar texto para destacar menções (converter @[Nome](ID) para @Nome visual)
        const processedText = this.formatMentionsForDisplay(internalText);

        commentItem.innerHTML = `
            <div class="flex justify-between items-start">
                <div class="flex-1">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-semibold text-gray-500">${authorName}</span>
                        <span class="text-gray-400 text-xs">${dateString} ${timeString}</span>
                    </div>
                    <span class="comment-text">${processedText}</span>
                </div>
                <div class="comment-actions flex gap-1 ml-2">
                    <button class="edit-comment-btn text-blue-500 hover:text-blue-700" title="Editar comentário">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                        </svg>
                    </button>
                    <button class="delete-comment-btn text-red-500 hover:text-red-700" title="Excluir comentário">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 000-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                        </svg>
                    </button>
                </div>
            </div>
        `;

        listEl.prepend(commentItem);

        // Adicionar event listeners para os novos botões
        commentItem.querySelector('.edit-comment-btn').addEventListener('click', (e) => {
            this.editComment(commentItem);
        });
        commentItem.querySelector('.delete-comment-btn').addEventListener('click', (e) => {
            this.deleteComment(commentItem);
        });

        // NOVO: Registrar atividade de comentário e enviar notificações
        if (taskId && projectId && project) {
            // Encontrar a tarefa para obter os responsáveis
            const task = project.tasks.find(t => t.id == taskId);
            const assignedUsers = task?.assignedUsers || [];

            // Obter o gestor do projeto
            const projectManager = project.manager;

            // Criar lista de destinatários (responsáveis + gestor do projeto)
            const notificationRecipients = [...assignedUsers];

            // Adicionar o gestor do projeto se existir e não estiver já na lista
            if (projectManager && !notificationRecipients.includes(projectManager)) {
                notificationRecipients.push(projectManager);
            }

            // Enviar notificações para responsáveis da tarefa e gestor do projeto
            if (notificationRecipients.length > 0) {
                await dataService.sendCommentNotification(taskId, taskName, projectId, projectName, text, notificationRecipients);
            }

            // Registrar atividade
            await dataService.logActivity(
                taskId,
                projectId,
                'commented',
                text,
                null,
                null
            );
        }
    },

    showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        const colors = { success: 'bg-green-600', error: 'bg-red-600' };
        toast.className = `toast text-white ${colors[type]}`;
        toast.innerHTML = `<p>${message}</p>`;
        container.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => {
            toast.classList.remove('show');
            toast.addEventListener('transitionend', () => toast.remove());
        }, 3000);
    },

    initTheme() {
        const theme = localStorage.getItem('theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (theme === 'dark' || (!theme && prefersDark)) {
            document.documentElement.classList.add('dark');
        }
        this.updateThemeIcons();
    },
    toggleTheme() {
        document.documentElement.classList.toggle('dark');
        localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
        this.updateThemeIcons();
        this.updateMainDashboard(dataService.projects);
        if (document.getElementById('view-switcher').value === 'gantt' && dataService.currentProjectId) {
            this.renderGanttChart(dataService.getCurrentProject().tasks, document.getElementById('task-filter-input').value);
        }
    },
    updateThemeIcons() {
        const isDark = document.documentElement.classList.contains('dark');
        document.getElementById('theme-icon-sun').style.display = isDark ? 'block' : 'none';
        document.getElementById('theme-icon-moon').style.display = isDark ? 'none' : 'block';
    },

    updateKpis: function (tasks) {
        const kpiDashboard = document.getElementById('kpi-dashboard');
        const overallProgress = dataService.getProjectProgress(tasks);
        const kpis = [
            { label: 'Progresso Geral', value: `${overallProgress}%` },
            { label: 'Total de Tarefas', value: tasks.length },
            { label: 'Concluídas', value: tasks.filter(t => t.status === 'Concluída').length },
            { label: 'Atrasadas', value: tasks.filter(t => reportService.getTaskStatusClass(t.status, dataService.getLatestDates(t).endDate).name === 'Atrasada').length },
            { label: 'Em Risco', value: tasks.filter(t => t.risk).length },
        ];
        kpiDashboard.innerHTML = kpis.map(kpi => `
            <div class="bg-[var(--card-bg)] p-4 rounded-lg shadow-md flex items-center gap-4 border border-[var(--border-color)]">
                <div> <div class="text-3xl font-bold">${kpi.value}</div> <div class="text-sm text-gray-400">${kpi.label}</div> </div>
            </div>`).join('');
    },
    renderAssigneeSummary(tasks) {
        const summaryContainer = document.getElementById('assignee-summary-list');
        const uidToName = new Map(dataService.users.map(u => [u.id, u.name || u.email.split('@')[0]]));

        const summary = tasks.reduce((acc, task) => {
            (task.assignedUsers || []).forEach(uid => {
                const userName = uidToName.get(uid) || `UID: ${uid.substring(0, 4)}`;
                if (!acc[userName]) acc[userName] = 0;
                acc[userName]++;
            });
            return acc;
        }, {});

        summaryContainer.innerHTML = Object.entries(summary).map(([name, count]) => `
            <div class="flex justify-between items-center">
                <span>${name}</span>
                <span class="font-bold bg-gray-200 dark:bg-gray-700 text-xs px-2 py-1 rounded-full">${count}</span>
            </div>
        `).join('');
    },

    // DASHBOARD MELHORADO com visual moderno e animações
    updateMainDashboard: function (projects) {
        const mainDashboard = document.getElementById('main-dashboard');

        // 1. Calcular métricas
        let inProgressCount = 0, overdueCount = 0, atRiskCount = 0, completedCount = 0;
        const totalProjects = projects.length;

        const overdueProjects = [];
        const inProgressProjects = [];
        const atRiskProjects = [];
        // completedProjects não é usado no visual, mas mantemos o cálculo para porcentagens se necessário

        projects.forEach(project => {
            const progress = dataService.getProjectProgress(project.tasks);

            if (progress === 100) {
                completedCount++;
            } else if (progress > 0) {
                inProgressCount++;
                inProgressProjects.push(project);
            }

            // Verifica atrasos
            const hasOverdue = project.tasks.some(t => {
                const dates = dataService.getLatestDates(t);
                return reportService.getTaskStatusClass(t.status, dates.endDate).name === 'Atrasada';
            });

            if (hasOverdue) {
                overdueCount++;
                overdueProjects.push(project);
            }

            // Verifica risco
            const hasRisk = project.tasks.some(t => t.risk);
            if (hasRisk) {
                atRiskCount++;
                atRiskProjects.push(project);
            }
        });

        // 2. Função auxiliar para criar a barra de progresso visual
        const createProgressBar = (percentage, label) => {
            const displayPercentage = Math.round(percentage);
            return `
                <div class="dashboard-progress-bar-container">
                    <div class="dashboard-progress-bar-header">
                        <span class="dashboard-progress-bar-label">${label}</span>
                        <span class="dashboard-progress-bar-value">${displayPercentage}%</span>
                    </div>
                    <div class="dashboard-progress-bar-track">
                        <div class="dashboard-progress-bar-fill" style="width: 0%" data-target-width="${displayPercentage}%"></div>
                    </div>
                </div>
            `;
        };

        // 3. Função auxiliar para criar a lista de projetos dentro do cartão
        const createProjectList = (projectList, maxShow = 4) => {
            if (projectList.length === 0) return '<div class="dashboard-projects-empty">Nenhum projeto nesta categoria</div>';

            // IMPORTANTE: Adicionamos data-project-id aqui para o clique funcionar
            const items = projectList.slice(0, maxShow).map(p => `
                <div class="dashboard-project-item" data-project-id="${p.id}" title="Abrir projeto: ${p.name}">
                    <span class="dashboard-project-dot"></span>
                    <span class="dashboard-project-name">${p.name}</span>
                </div>
            `).join('');

            const more = projectList.length > maxShow ?
                `<div class="dashboard-card-more">+ ${projectList.length - maxShow} mais</div>` : '';

            return items + more;
        };

        // 4. Definição dos Cartões (SEM o cartão de Concluídos)
        const cards = [
            {
                id: 'total',
                value: totalProjects,
                label: 'Total de Projetos',
                colorClass: 'blue',
                percentage: 100,
                projects: projects, // Mostra todos
                icon: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>`
            },
            {
                id: 'in-progress',
                value: inProgressCount,
                label: 'Em Andamento',
                colorClass: 'amber',
                percentage: totalProjects > 0 ? (inProgressCount / totalProjects) * 100 : 0,
                projects: inProgressProjects,
                icon: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`
            },
            {
                id: 'overdue',
                value: overdueCount,
                label: 'Atrasados',
                colorClass: 'red',
                percentage: totalProjects > 0 ? (overdueCount / totalProjects) * 100 : 0,
                projects: overdueProjects,
                icon: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
            },
            {
                id: 'at-risk',
                value: atRiskCount,
                label: 'Em Risco',
                colorClass: 'orange',
                percentage: totalProjects > 0 ? (atRiskCount / totalProjects) * 100 : 0,
                projects: atRiskProjects,
                icon: `<svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`
            }
        ];

        // 5. Renderizar HTML
        mainDashboard.innerHTML = cards.map(card => `
            <div class="dashboard-card card-${card.colorClass}">
                <div class="dashboard-card-header">
                    <div class="dashboard-card-icon icon-${card.colorClass}">
                        ${card.icon}
                    </div>
                    <div class="dashboard-card-info">
                        <div class="dashboard-card-value">${card.value}</div>
                        <div class="dashboard-card-label">${card.label}</div>
                    </div>
                </div>
                ${card.id !== 'total' ? createProgressBar(card.percentage, 'do total') : ''}
                <div class="dashboard-card-projects">
                    ${createProjectList(card.projects)}
                </div>
            </div>
        `).join('');

        // 6. Adicionar Event Listeners para o CLIQUE (A parte que faz navegar)
        const projectItems = mainDashboard.querySelectorAll('.dashboard-project-item');
        projectItems.forEach(item => {
            item.style.cursor = 'pointer'; // Garante que o mouse vire mãozinha

            item.addEventListener('click', (e) => {
                e.stopPropagation(); // Evita conflitos
                const projectId = item.dataset.projectId;

                if (projectId) {
                    console.log("Navegando para o projeto:", projectId); // Debug
                    // Usa o objeto global App para navegar
                    App.openProject(projectId);
                } else {
                    console.error("ID do projeto não encontrado no elemento");
                }
            });
        });

        // 7. Animações visuais (Contadores e Barras)
        setTimeout(() => {
            mainDashboard.querySelectorAll('.dashboard-card-value').forEach((el, index) => {
                if (cards[index]) {
                    this.animateValue(el, 0, cards[index].value, 1000);
                }
            });

            mainDashboard.querySelectorAll('.dashboard-progress-bar-fill').forEach(bar => {
                const targetWidth = bar.dataset.targetWidth;
                setTimeout(() => {
                    bar.style.width = targetWidth;
                }, 100);
            });
        }, 300);
    },

    // Função para animar valores numéricos
    animateValue: function (element, start, end, duration) {
        const startTime = performance.now();
        const updateValue = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const easeOutQuart = 1 - Math.pow(1 - progress, 4);
            const currentValue = Math.floor(start + (end - start) * easeOutQuart);
            element.textContent = currentValue;
            if (progress < 1) {
                requestAnimationFrame(updateValue);
            }
        };
        requestAnimationFrame(updateValue);
    },

    // FUNÇÕES ADICIONADAS PARA CORRIGIR OS ERROS
    renderProjectList: function (projects) {
        const projectListContainer = document.getElementById('project-list');
        const isFinalized = this.currentProjectTab === 'finalized';

        if (!projects || projects.length === 0) {
            projectListContainer.innerHTML = `
                <div class="col-span-full text-center py-8">
                    <p class="text-gray-400">${isFinalized ? 'Nenhum projeto finalizado.' : 'Nenhum projeto encontrado.'}</p>
                    <p class="text-sm text-gray-500 mt-2">${isFinalized ? 'Projetos 100% concluídos podem ser finalizados e aparecerão aqui.' : 'Crie seu primeiro projeto clicando no botão acima.'}</p>
                </div>
            `;
            return;
        }

        projectListContainer.innerHTML = projects.map(project => {
            const progress = dataService.getProjectProgress(project.tasks);
            const statusInfo = reportService.getTaskStatusClass(
                progress === 100 ? 'Concluída' : progress > 0 ? 'Em Andamento' : 'Não Iniciada',
                ''
            );

            const canDelete = dataService.userRole === 'Gestor' || project.creatorId === dataService.userId;

            // CORREÇÃO: Usar nome do responsável em vez de UID
            const managerName = dataService.getManagerName(project.manager);

            // NOVO: Exibir datas do projeto no card
            const startDate = project.startDate ? new Date(project.startDate).toLocaleDateString('pt-BR') : 'Não definida';
            const endDate = project.endDate ? new Date(project.endDate).toLocaleDateString('pt-BR') : 'Não definida';

            // Verificar se o projeto está atrasado
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const startDateObj = project.startDate ? new Date(project.startDate) : null;
            const endDateObj = project.endDate ? new Date(project.endDate) : null;
            const isOverdue = endDateObj && endDateObj < today && progress < 100;
            const cardClass = isOverdue ? 'project-overdue' : '';

            // Calcular duração e dias
            let totalDays = 0;
            let currentDay = 0;
            let daysDelayed = 0;
            let durationInfo = '';

            if (startDateObj && endDateObj) {
                startDateObj.setHours(0, 0, 0, 0);
                endDateObj.setHours(0, 0, 0, 0);

                // Duração total do projeto em dias
                totalDays = Math.ceil((endDateObj - startDateObj) / (1000 * 60 * 60 * 24)) + 1;

                // Qual dia estamos (desde o início)
                if (today >= startDateObj) {
                    currentDay = Math.ceil((today - startDateObj) / (1000 * 60 * 60 * 24)) + 1;
                    if (currentDay > totalDays) currentDay = totalDays;
                } else {
                    currentDay = 0; // Projeto ainda não iniciou
                }

                // Dias de atraso (se passou da data de término e não está 100%)
                if (today > endDateObj && progress < 100) {
                    daysDelayed = Math.ceil((today - endDateObj) / (1000 * 60 * 60 * 24));
                }
            }

            // NOVO: Obter informações das tarefas
            const todayTask = dataService.taskService.getFirstTodayTask(project);
            const overdueTasks = dataService.taskService.getOverdueTasks(project);

            // Verificar se é projeto finalizado
            const isFinalizedProject = project.finalized === true;
            const finalizedCardClass = isFinalizedProject ? 'border-green-500 bg-green-50/50 dark:bg-green-900/10' : '';
            const finalizedDate = project.finalizedAt ? new Date(project.finalizedAt).toLocaleDateString('pt-BR') : '';

            return `
                <div class="project-card-link bg-[var(--card-bg)] rounded-lg shadow-md p-6 border border-[var(--border-color)] hover:shadow-lg transition-shadow cursor-pointer ${cardClass} ${finalizedCardClass}" data-project-id="${project.id}">
                    ${isFinalizedProject ? `
                        <div class="mb-3 flex items-center gap-2 text-green-600 dark:text-green-400">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
                            </svg>
                            <span class="font-semibold">Projeto Finalizado</span>
                            ${finalizedDate ? `<span class="text-xs text-gray-500">em ${finalizedDate}</span>` : ''}
                        </div>
                    ` : ''}
                    <div class="flex justify-between items-start mb-4">
                        <h3 class="text-xl font-semibold text-[var(--text-color)]">${project.name}</h3>
                        ${canDelete ? `
                            <button class="delete-project-btn text-red-500 hover:text-red-700 p-1 rounded-full hover:bg-red-100 dark:hover:bg-red-900 transition-colors" data-project-id="${project.id}" title="Excluir projeto">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                    <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                                </svg>
                            </button>
                        ` : ''}
                    </div>
                    
                    <div class="mb-4">
                        <div class="flex justify-between text-sm text-gray-400 mb-1">
                            <span>Progresso</span>
                            <span>${progress}%</span>
                        </div>
                        <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                            <div class="bg-blue-600 h-2 rounded-full" style="width: ${progress}%"></div>
                        </div>
                    </div>
                    
                    <!-- Duração e dias do projeto -->
                    <div class="mb-3 text-xs">
                        ${totalDays > 0 ? `
                            <div class="flex items-center justify-between mb-2 p-2 rounded-lg ${daysDelayed > 0 ? 'bg-red-50 dark:bg-red-900/20' : 'bg-blue-50 dark:bg-blue-900/20'}">
                                <div class="flex items-center gap-2">
                                    <span class="text-lg">📆</span>
                                    <div>
                                        <div class="font-semibold ${daysDelayed > 0 ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'}">
                                            ${currentDay === 0 ? 'Aguardando início' : `Dia ${currentDay} de ${totalDays}`}
                                        </div>
                                        <div class="text-gray-500">Duração: ${totalDays} dia(s)</div>
                                    </div>
                                </div>
                                ${daysDelayed > 0 ? `
                                    <div class="text-right">
                                        <div class="bg-red-600 text-white text-xs px-2 py-1 rounded-full font-bold">
                                            ⚠️ ${daysDelayed} dia(s) de atraso
                                        </div>
                                    </div>
                                ` : (currentDay > 0 && progress === 100 ? `
                                    <div class="bg-green-600 text-white text-xs px-2 py-1 rounded-full font-bold">
                                        ✅ Concluído
                                    </div>
                                ` : '')}
                            </div>
                            
                            <!-- Barra de progresso de tempo -->
                            <div class="mb-2">
                                <div class="flex justify-between text-xs text-gray-400 mb-1">
                                    <span>${startDate}</span>
                                    <span>${endDate}</span>
                                </div>
                                <div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 relative">
                                    <div class="${daysDelayed > 0 ? 'bg-red-500' : 'bg-blue-400'} h-1.5 rounded-full transition-all" style="width: ${Math.min((currentDay / totalDays) * 100, 100)}%"></div>
                                </div>
                            </div>
                        ` : `
                            <div class="text-gray-500 text-center py-2">
                                Datas não definidas
                            </div>
                        `}
                    </div>
                    
                    <!-- NOVO: Informações das tarefas -->
                    <div class="task-info-container">
                        ${todayTask ? `
                            <div class="flex items-center text-xs text-green-600 mb-1">
                                <span class="mr-1">📅</span>
                                <span class="font-medium">Hoje:</span>
                                <span class="ml-1 truncate">${todayTask.name}</span>
                                <span class="today-task-badge task-info-badge">Hoje</span>
                            </div>
                        ` : ''}
                        
                        ${overdueTasks.length > 0 ? `
                            <div class="flex items-center text-xs text-red-600">
                                <span class="mr-1">⚠️</span>
                                <span class="font-medium">Atrasadas:</span>
                                <span class="ml-1">${overdueTasks.length} tarefa(s)</span>
                                <span class="overdue-task-badge task-info-badge">${overdueTasks.length}</span>
                            </div>
                        ` : ''}
                        
                        ${!todayTask && overdueTasks.length === 0 ? `
                            <div class="text-xs text-gray-500">
                                Nenhuma tarefa em execução hoje
                            </div>
                        ` : ''}
                    </div>
                    
                    <div class="flex justify-between items-center text-sm mt-3">
                        <div class="flex items-center gap-4">
                            <span class="px-2 py-1 rounded-full text-xs ${isOverdue ? 'bg-red-600 text-white' : statusInfo.badge}">
                                ${isOverdue ? 'Atrasado' : progress === 100 ? 'Concluído' : progress > 0 ? 'Em Andamento' : 'Não Iniciado'}
                            </span>
                            <span class="text-gray-400">${project.tasks?.length || 0} tarefas</span>
                        </div>
                        <div class="text-gray-400 text-xs">
                            Responsável: ${managerName}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    },

    // NOVA FUNÇÃO: Atualizar informações das tarefas de hoje no header
    updateTodayTasksInfo: function (todayTasksCount) {
        let todayInfoEl = document.getElementById('today-tasks-info');

        if (!todayInfoEl) {
            // Criar elemento se não existir
            const projectTitle = document.getElementById('project-title');
            if (projectTitle && projectTitle.parentNode) {
                const headerContainer = projectTitle.parentNode;
                todayInfoEl = document.createElement('div');
                todayInfoEl.id = 'today-tasks-info';
                todayInfoEl.className = 'mt-2 text-sm';
                headerContainer.appendChild(todayInfoEl);
            }
        }

        if (todayInfoEl) {
            const today = new Date().toLocaleDateString('pt-BR');
            if (todayTasksCount > 0) {
                todayInfoEl.innerHTML = `
                    <span class="bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 px-3 py-1 rounded-full font-medium animate-pulse">
                        📅 Hoje (${today}): ${todayTasksCount} tarefa(s) em execução
                    </span>
                `;
            } else {
                todayInfoEl.innerHTML = `
                    <span class="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-3 py-1 rounded-full">
                        📅 Hoje (${today}): Nenhuma tarefa em execução
                    </span>
                `;
            }
        }
    },

    // FUNÇÃO renderTaskTable COM SISTEMA EXPANDIR/RECOLHER
    renderTaskTable: function (tasks) {
        const tableBody = document.getElementById('task-table-body');

        if (!tasks || tasks.length === 0) {
            tableBody.innerHTML = `
    <tr>
        <td colspan="8" class="p-4 text-center text-gray-400">
            Nenhuma tarefa encontrada. Clique em "Nova Tarefa" para começar.
        </td>
    </tr>
`;
            return;
        }

        // Estado de expansão (armazena quais tarefas pai estão expandidas)
        if (!this.expandedTasks) {
            this.expandedTasks = new Set();
        }

        // CORREÇÃO: Criar um mapa de tarefas para acesso rápido
        const taskMap = new Map();
        tasks.forEach(task => {
            taskMap.set(task.id, task);
        });

        // Função para verificar se uma tarefa tem subtarefas
        const hasSubtasks = (taskId) => {
            return tasks.some(t => t.parentId === taskId);
        };

        // Função para verificar se uma tarefa está expandida
        const isExpanded = (taskId) => {
            return this.expandedTasks.has(taskId);
        };

        // Função para alternar expansão
        const toggleExpansion = (taskId) => {
            if (isExpanded(taskId)) {
                this.expandedTasks.delete(taskId);
            } else {
                this.expandedTasks.add(taskId);
            }
            // Re-renderizar a tabela
            this.renderTaskTable(tasks);
        };

        // Função recursiva para renderizar tarefas
        const renderTaskRow = (task, level = 0, isChild = false) => {
            const latestDates = dataService.getLatestDates(task);
            const duration = reportService.calculateDuration(latestDates.startDate, latestDates.endDate);
            const statusInfo = reportService.getTaskStatusClass(task.status, latestDates.endDate);
            const isParent = hasSubtasks(task.id);
            const expanded = isExpanded(task.id);

            // Verificar se a tarefa está em execução hoje
            const isRunningToday = dataService.taskService.isTaskRunningToday(task);

            // Usar nomes em vez de UIDs
            const assignedUsersText = dataService.getAssignedUserNames(task.assignedUsers);

            const commentsPreview = (task.comments || [])
                .slice(0, 2)
                .map(c => `${c.author || 'Utilizador'}: ${c.text.substring(0, 30)}${c.text.length > 30 ? '...' : ''}`)
                .join('; ');

            // Ícone de expansão para tarefas pai
            const expandIcon = isParent ?
                `<button class="expand-btn text-gray-500 hover:text-blue-500 transition-transform ${expanded ? 'rotate-90' : ''}" 
            data-task-id="${task.id}" title="${expanded ? 'Recolher' : 'Expandir'}">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd" />
        </svg>
    </button>` :
                '<div class="w-4 h-4"></div>'; // Espaço vazio para alinhamento

            // Ícone da tarefa
            const taskIcon = isParent ? '📁' : '📄';

            // Ícone de "hoje" para tarefas em execução
            const todayIcon = isRunningToday ?
                '<span class="ml-2 text-green-500 animate-pulse" title="Em execução hoje">🟢</span>' : '';

            // Background para subtarefas
            const rowClass = isChild ? 'bg-gray-50 dark:bg-gray-800' : '';
            const todayHighlightClass = isRunningToday ? 'today-running-task' : '';

            return `
    <tr class="border-b border-[var(--border-color)] hover:bg-gray-100 dark:hover:bg-gray-700 ${rowClass} ${todayHighlightClass} draggable-task" data-task-id="${task.id}" data-level="${level}" data-parent-id="${task.parentId || 'root'}">
        <td class="p-3">
            <div style="padding-left: ${level * 20}px" class="flex items-center gap-2">
                <span class="drag-handle cursor-grab" title="Arrastar para reordenar">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-gray-400" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M7 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 2zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 7 14zm6-8a2 2 0 1 0-.001-4.001A2 2 0 0 0 13 6zm0 2a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 8zm0 6a2 2 0 1 0 .001 4.001A2 2 0 0 0 13 14z"/>
                    </svg>
                </span>
                ${expandIcon}
                <span class="${isParent ? 'text-blue-500' : 'text-gray-400'}">${taskIcon}</span>
                <span class="task-edit-trigger cursor-pointer hover:text-blue-500 hover:underline font-${level === 0 ? 'medium' : 'normal'}" data-task-id="${task.id}">
                    ${task.name}
                </span>
                ${todayIcon}
                ${task.risk ? '<span class="text-red-500 text-xs ml-1" title="Tarefa em risco">⚠️</span>' : ''}
                ${isParent ? `<span class="text-xs text-blue-500 bg-blue-100 dark:bg-blue-800 px-2 py-1 rounded-full ml-2">${tasks.filter(t => t.parentId === task.id).length}</span>` : ''}
                ${task.manualOrder ? '<span class="text-xs text-orange-500 ml-1" title="Ordem manual">↕️</span>' : ''}
            </div>
        </td>
        <td class="p-3">${duration}</td>
        <td class="p-3">${new Date(latestDates.startDate + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
        <td class="p-3">${new Date(latestDates.endDate + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
        <td class="p-3">
            <span class="px-2 py-1 rounded-full text-xs ${statusInfo.badge}">
                ${statusInfo.name}
            </span>
        </td>
        <td class="p-3 text-xs text-gray-500 max-w-xs truncate" title="${assignedUsersText}">
            ${assignedUsersText}
        </td>
        <td class="p-3 text-xs text-gray-500 max-w-xs truncate" title="${commentsPreview}">
            ${commentsPreview || '-'}
        </td>
        <td class="p-3 text-center no-print">
            <div class="flex justify-center gap-1">
                <button class="add-subtask-btn bg-green-500 text-white p-1 rounded hover:bg-green-600" 
                        data-task-id="${task.id}" data-parent-id="${task.id}" title="Adicionar subtarefa">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" />
                    </svg>
                </button>
                <button class="edit-task-btn bg-blue-500 text-white p-1 rounded hover:bg-blue-600" 
                        data-task-id="${task.id}" title="Editar tarefa">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                    </svg>
                </button>
                <button class="delete-task-btn bg-red-500 text-white p-1 rounded hover:bg-red-600" 
                        data-task-id="${task.id}" title="Excluir tarefa">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 000-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                    </svg>
                </button>
            </div>
        </td>
    </tr>
`;
        };

        // Função para renderizar tarefas recursivamente
        const renderTasksRecursive = (parentId = null, level = 0) => {
            let html = '';

            // Obter tarefas deste nível
            const currentTasks = tasks
                .filter(t => t.parentId === parentId)
                .sort((a, b) => {
                    const orderA = a.order || 0;
                    const orderB = b.order || 0;
                    if (orderA !== orderB) return orderA - orderB;

                    const dateA = new Date(dataService.getLatestDates(a).startDate);
                    const dateB = new Date(dataService.getLatestDates(b).startDate);
                    return dateA - dateB;
                });

            // Renderizar cada tarefa
            currentTasks.forEach(task => {
                html += renderTaskRow(task, level, parentId !== null);

                // Se é uma tarefa pai E está expandida, renderizar subtarefas
                if (hasSubtasks(task.id) && isExpanded(task.id)) {
                    html += renderTasksRecursive(task.id, level + 1);
                }
            });

            return html;
        };

        // Renderizar todas as tarefas começando do nível raiz
        tableBody.innerHTML = renderTasksRecursive();

        // Adicionar event listeners para os botões de expandir/recolher
        setTimeout(() => {
            tableBody.querySelectorAll('.expand-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const taskId = parseFloat(btn.dataset.taskId);
                    toggleExpansion(taskId);
                });
            });

            // Configurar drag and drop para subtarefas
            this.setupSubtasksDragAndDrop();
        }, 50);

        // NOVO: Adicionar contador de tarefas em execução hoje
        const todayTasksCount = tasks.filter(task =>
            dataService.taskService.isTaskRunningToday(task)
        ).length;

        // Atualizar o header do dashboard com informação das tarefas de hoje
        this.updateTodayTasksInfo(todayTasksCount);
    },

    renderGanttChart: function (tasks) {
        const ganttView = document.getElementById('gantt-view');
        if (!tasks || tasks.length === 0 || ganttView.classList.contains('hidden')) return;

        const taskNamesContainer = document.getElementById('gantt-task-names');
        const timelineBody = document.getElementById('gantt-timeline-body');
        const ganttHeader = document.getElementById('gantt-header');
        const dependencyLines = document.getElementById('gantt-dependency-lines');
        taskNamesContainer.innerHTML = ''; timelineBody.innerHTML = ''; ganttHeader.innerHTML = ''; dependencyLines.innerHTML = '';

        const allDates = tasks.flatMap(t => t.dateHistory.flatMap(d => [new Date(d.startDate), new Date(d.endDate)]))
            .filter(d => !isNaN(d.getTime()));
        if (allDates.length === 0) return;

        let minDate = new Date(Math.min.apply(null, allDates));
        let maxDate = new Date(Math.max.apply(null, allDates));
        minDate.setDate(minDate.getDate() - 2); maxDate.setDate(maxDate.getDate() + 2);

        const totalDays = reportService.calculateDuration(minDate.toISOString().split('T')[0], maxDate.toISOString().split('T')[0]);
        if (totalDays <= 0) return;
        const dayWidth = 40;

        timelineBody.style.width = `${totalDays * dayWidth}px`;
        ganttHeader.style.width = `${totalDays * dayWidth}px`;

        let currentDate = new Date(minDate);
        ganttHeader.style.display = 'flex';
        for (let i = 1; i <= totalDays; i++) {
            const dayCell = document.createElement('div');
            const isWeekend = currentDate.getDay() === 0 || currentDate.getDay() === 6;
            dayCell.className = `text-center text-xs p-1 border-r border-b border-[var(--border-color)] shrink-0 ${isWeekend ? 'bg-gray-300 dark:bg-gray-800 font-semibold' : ''}`;
            dayCell.style.width = `${dayWidth}px`;
            dayCell.textContent = `${currentDate.getDate()}/${currentDate.getMonth() + 1}`;
            ganttHeader.appendChild(dayCell);
            currentDate.setDate(currentDate.getDate() + 1);
        }

        let taskOrder = [];
        const processGanttTasks = (parentId, level) => {
            tasks.filter(t => t.parentId === parentId).sort((a, b) => {
                const dateA = new Date(dataService.getLatestDates(a).startDate);
                const dateB = new Date(dataService.getLatestDates(b).startDate);
                return dateA - dateB;
            }).forEach(task => { taskOrder.push({ ...task, level }); processGanttTasks(task.id, level + 1); });
        };
        processGanttTasks(null, 0);

        taskOrder.forEach(task => {
            const latestDates = dataService.getLatestDates(task);
            if (!latestDates.startDate || !latestDates.endDate) return;

            const taskNameDiv = document.createElement('div');
            taskNameDiv.className = 'gantt-task-name h-8 flex items-center border-b border-[var(--border-color)] text-sm';
            taskNameDiv.style.paddingLeft = `${task.level * 16 + 8}px`;
            taskNameDiv.textContent = task.name;
            taskNamesContainer.appendChild(taskNameDiv);

            const start = new Date(latestDates.startDate + 'T00:00:00');
            const end = new Date(latestDates.endDate + 'T00:00:00');
            const startOffset = reportService.calculateDuration(minDate.toISOString().split('T')[0], latestDates.startDate);
            const taskDuration = reportService.calculateDuration(latestDates.startDate, latestDates.endDate);

            const taskBar = document.createElement('div');
            taskBar.className = `gantt-bar ${task.level === 0 ? 'gantt-bar-parent' : ''}`;
            taskBar.style.left = `${startOffset * dayWidth}px`;
            taskBar.style.width = `${taskDuration * dayWidth}px`;
            taskBar.style.top = `${taskOrder.indexOf(task) * 32 + (task.level === 0 ? 8 : 20)}px`;
            taskBar.style.backgroundColor = task.risk ? '#ef4444' : (task.status === 'Concluída' ? '#10b981' : (task.status === 'Em Andamento' ? '#f59e0b' : '#6b7280'));
            taskBar.textContent = taskDuration > 2 ? task.name : '';
            taskBar.title = `${task.name}: ${latestDates.startDate} a ${latestDates.endDate}`;
            taskBar.addEventListener('click', () => uiService.openTaskModal('edit', { taskId: task.id }));
            timelineBody.appendChild(taskBar);
        });
    }
};

// Report Service - Handles exports and reporting
const reportService = {
    calculateDuration: (startDate, endDate) => {
        if (!startDate || !endDate) return 0;
        const start = new Date(startDate + 'T00:00:00');
        const end = new Date(endDate + 'T00:00:00');
        const timeDiff = end.getTime() - start.getTime();
        return Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1;
    },
    getTaskStatusClass: (status, endDate) => {
        const today = new Date();
        const end = new Date(endDate + 'T00:00:00');
        if (status === 'Concluída') return { name: 'Concluída', badge: 'bg-green-600 text-white' };
        if (status === 'Em Andamento' && end < today) return { name: 'Atrasada', badge: 'bg-red-600 text-white' };
        if (status === 'Em Andamento') return { name: 'Em Andamento', badge: 'bg-yellow-500 text-black' };
        if (end < today) return { name: 'Atrasada', badge: 'bg-red-600 text-white' };
        return { name: 'Não Iniciada', badge: 'bg-gray-500 text-white' };
    },
    exportExcel: (project) => {
        if (!project) return uiService.showToast('Nenhum projeto selecionado.', 'error');

        const tasks = project.tasks || [];
        const today = new Date().toLocaleDateString('pt-BR');

        // Calcular estatísticas (igual ao PDF)
        const stats = {
            total: tasks.length,
            concluidas: tasks.filter(t => t.status === 'Concluída').length,
            emAndamento: tasks.filter(t => t.status === 'Em Andamento').length,
            naoIniciadas: tasks.filter(t => t.status === 'Não Iniciada').length,
            atrasadas: tasks.filter(t => {
                const latestDates = dataService.getLatestDates(t);
                return t.status !== 'Concluída' && new Date(latestDates.endDate) < new Date();
            }).length,
            emRisco: tasks.filter(t => t.risk).length
        };
        const progressoGeral = dataService.getProjectProgress(tasks);

        // Função para construir hierarquia (igual ao PDF)
        const buildHierarchicalTasks = (tasksArray) => {
            const result = [];
            const processedIds = new Set();
            const normalizeId = (id) => (id === null || id === undefined || id === '') ? null : String(id);
            const isRootTask = (task) => task.parentId === null || task.parentId === undefined || task.parentId === '';
            const sortByDate = (a, b) => {
                const dateA = new Date(dataService.getLatestDates(a).startDate);
                const dateB = new Date(dataService.getLatestDates(b).startDate);
                return dateA - dateB;
            };
            const addTaskWithChildren = (task, level = 0) => {
                const taskIdStr = normalizeId(task.id);
                if (taskIdStr !== null && processedIds.has(taskIdStr)) return;
                if (taskIdStr !== null) processedIds.add(taskIdStr);
                result.push({ ...task, level });
                const children = tasksArray.filter(t => {
                    const parentIdStr = normalizeId(t.parentId);
                    return parentIdStr !== null && taskIdStr !== null && parentIdStr === taskIdStr;
                });
                children.sort(sortByDate);
                children.forEach(child => addTaskWithChildren(child, level + 1));
            };
            const rootTasks = tasksArray.filter(isRootTask);
            rootTasks.sort(sortByDate);
            rootTasks.forEach(parent => addTaskWithChildren(parent, 0));
            return result;
        };

        const sortedTasks = buildHierarchicalTasks(tasks);

        // Criar dados do Excel com cabeçalho igual ao PDF
        const excelData = [];

        // Linha 1: Título do projeto
        excelData.push(['', project.name, '', '', '', '', '', '', '']);
        excelData.push(['', `Gerado em: ${today}`, '', '', '', '', '', '', '']);
        excelData.push([]); // Linha vazia

        // Linha 4: Resumo de estatísticas (igual ao PDF)
        excelData.push([
            'Total',
            'Concluídas',
            'Em Andamento',
            'Atrasadas',
            'Em Risco',
            'Progresso Geral',
            '', '', ''
        ]);
        excelData.push([
            stats.total,
            stats.concluidas,
            stats.emAndamento,
            stats.atrasadas,
            stats.emRisco,
            `${progressoGeral}%`,
            '', '', ''
        ]);
        excelData.push([]); // Linha vazia

        // Linha 7: Cabeçalho da tabela de tarefas
        excelData.push([
            'Tarefa',
            'Data Início',
            'Data Término',
            'Duração (dias)',
            'Status',
            'Progresso (%)',
            'Prioridade',
            'Responsável',
            'Risco'
        ]);

        // Tarefas ordenadas hierarquicamente
        sortedTasks.forEach(t => {
            const latestDates = dataService.getLatestDates(t);
            const statusInfo = reportService.getTaskStatusClass(t.status, latestDates.endDate);

            // Tarefas pai em MAIÚSCULAS, subtarefas com indentação
            let taskName;
            if (t.level === 0) {
                taskName = t.name.toUpperCase(); // Tarefa pai em maiúsculas
            } else {
                taskName = '  '.repeat(t.level) + '↳ ' + t.name; // Subtarefa com indent
            }

            excelData.push([
                taskName,

                latestDates.startDate || '',
                latestDates.endDate || '',
                reportService.calculateDuration(latestDates.startDate, latestDates.endDate),
                statusInfo.name,
                t.progress || 0,
                t.priority || 'Média',
                dataService.getAssignedUserNames(t.assignedUsers),
                t.risk ? 'Sim' : 'Não'
            ]);
        });

        // Criar worksheet
        const worksheet = XLSX.utils.aoa_to_sheet(excelData);

        // Definir largura das colunas
        worksheet['!cols'] = [
            { wch: 40 },  // Tarefa
            { wch: 12 },  // Data Início
            { wch: 12 },  // Data Término
            { wch: 12 },  // Duração
            { wch: 14 },  // Status
            { wch: 12 },  // Progresso
            { wch: 10 },  // Prioridade
            { wch: 25 },  // Responsável
            { wch: 8 }    // Risco
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Relatório');
        XLSX.writeFile(workbook, `${project.name}_relatorio.xlsx`);
        uiService.showToast('Exportado para Excel com sucesso!');
    },

    generatePdf: (project) => {
        if (!project) return uiService.showToast('Nenhum projeto selecionado.', 'error');

        const tasks = project.tasks || [];
        const today = new Date().toLocaleDateString('pt-BR');

        const stats = {
            total: tasks.length,
            concluidas: tasks.filter(t => t.status === 'Concluída').length,
            emAndamento: tasks.filter(t => t.status === 'Em Andamento').length,
            naoIniciadas: tasks.filter(t => t.status === 'Não Iniciada').length,
            atrasadas: tasks.filter(t => {
                const latestDates = dataService.getLatestDates(t);
                return t.status !== 'Concluída' && new Date(latestDates.endDate) < new Date();
            }).length,
            emRisco: tasks.filter(t => t.risk).length
        };

        // CORREÇÃO: Usar o mesmo cálculo de progresso da UI
        const progressoGeral = dataService.getProjectProgress(tasks);

        // Função auxiliar para construir hierarquia (presente no Cronograma.html)
        const buildHierarchicalTasks = (tasksArray) => {
            const result = [];
            const processedIds = new Set();

            const normalizeId = (id) => (id === null || id === undefined || id === '') ? null : String(id);
            const isRootTask = (task) => task.parentId === null || task.parentId === undefined || task.parentId === '';

            const sortByDate = (a, b) => {
                const dateA = new Date(dataService.getLatestDates(a).startDate);
                const dateB = new Date(dataService.getLatestDates(b).startDate);
                return dateA - dateB;
            };

            const addTaskWithChildren = (task) => {
                const taskIdStr = normalizeId(task.id);
                if (taskIdStr !== null && processedIds.has(taskIdStr)) return;
                if (taskIdStr !== null) processedIds.add(taskIdStr);
                result.push(task);

                const children = tasksArray.filter(t => {
                    const parentIdStr = normalizeId(t.parentId);
                    return parentIdStr !== null && taskIdStr !== null && parentIdStr === taskIdStr;
                });
                children.sort(sortByDate);
                children.forEach(child => addTaskWithChildren(child));
            };

            const rootTasks = tasksArray.filter(isRootTask);
            rootTasks.sort(sortByDate);
            rootTasks.forEach(parent => addTaskWithChildren(parent));

            const orphans = tasksArray.filter(task => {
                const taskIdStr = normalizeId(task.id);
                return taskIdStr !== null && !processedIds.has(taskIdStr);
            });
            orphans.sort(sortByDate);
            orphans.forEach(task => {
                const taskIdStr = normalizeId(task.id);
                processedIds.add(taskIdStr);
                result.push(task);
            });

            return result;
        };

        const sortedTasks = buildHierarchicalTasks(tasks);

        let tasksHtml = '';
        sortedTasks.forEach((task, index) => {
            const latestDates = dataService.getLatestDates(task);
            const duration = reportService.calculateDuration(latestDates.startDate, latestDates.endDate);
            const statusInfo = reportService.getTaskStatusClass(task.status, latestDates.endDate);
            const isSubtask = task.parentId !== null;

            let statusColor = '#6b7280';
            let statusTextColor = '#fff';
            if (statusInfo.badge.includes('green')) statusColor = '#10b981';
            else if (statusInfo.badge.includes('red')) statusColor = '#ef4444';
            else if (statusInfo.badge.includes('yellow')) { statusColor = '#f59e0b'; statusTextColor = '#000'; }

            tasksHtml += '<tr style="background-color: ' + (index % 2 === 0 ? '#ffffff' : '#f9fafb') + '; ' + (isSubtask ? 'font-size: 11px;' : '') + '">' +
                '<td style="padding: 8px; border: 1px solid #e5e7eb; ' + (isSubtask ? 'padding-left: 24px;' : 'font-weight: 600;') + '">' + (isSubtask ? '+ ' : '') + task.name + '</td>' +
                '<td style="padding: 8px; border: 1px solid #e5e7eb; text-align: center;">' + duration + '</td>' +
                '<td style="padding: 8px; border: 1px solid #e5e7eb; text-align: center;">' + new Date(latestDates.startDate + 'T00:00:00').toLocaleDateString('pt-BR') + '</td>' +
                '<td style="padding: 8px; border: 1px solid #e5e7eb; text-align: center;">' + new Date(latestDates.endDate + 'T00:00:00').toLocaleDateString('pt-BR') + '</td>' +
                '<td style="padding: 8px; border: 1px solid #e5e7eb; text-align: center;"><span style="background-color: ' + statusColor + '; color: ' + statusTextColor + '; padding: 2px 8px; border-radius: 9999px; font-size: 10px;">' + statusInfo.name + '</span></td>' +
                '<td style="padding: 8px; border: 1px solid #e5e7eb; text-align: center;">' + (task.progress || 0) + '%</td>' +
                '<td style="padding: 8px; border: 1px solid #e5e7eb;">' + dataService.getAssignedUserNames(task.assignedUsers) + '</td>' +
                '<td style="padding: 8px; border: 1px solid #e5e7eb; text-align: center;">' + (task.risk ? 'Sim' : 'Não') + '</td>' +
                '</tr>';
        });

        const htmlContent = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;margin:0;padding:20px;background:#fff;color:#333;}table{width:100%;border-collapse:collapse;font-size:12px;}.stats-container{display:table;width:100%;margin-bottom:20px;}.stat-box{display:table-cell;width:20%;text-align:center;padding:15px;color:#fff;}.stat-box.blue{background:#3b82f6;}.stat-box.green{background:#10b981;}.stat-box.yellow{background:#f59e0b;}.stat-box.red{background:#ef4444;}.stat-box.purple{background:#8b5cf6;}.stat-number{font-size:28px;font-weight:bold;}.stat-label{font-size:11px;}</style></head><body>' +
            '<div style="text-align:center;margin-bottom:30px;border-bottom:3px solid #2563eb;padding-bottom:20px;">' +
            '<h1 style="color:#1e40af;margin:0;font-size:24px;">RELATÓRIO DE PROJETO</h1>' +
            '<h2 style="color:#374151;margin:10px 0 5px 0;font-size:20px;">' + project.name + '</h2>' +
            '<p style="color:#6b7280;margin:0;font-size:12px;">Gerado em: ' + today + '</p></div>' +
            '<div class="stats-container">' +
            '<div class="stat-box blue"><div class="stat-number">' + stats.total + '</div><div class="stat-label">Total</div></div>' +
            '<div class="stat-box green"><div class="stat-number">' + stats.concluidas + '</div><div class="stat-label">Concluídas</div></div>' +
            '<div class="stat-box yellow"><div class="stat-number">' + stats.emAndamento + '</div><div class="stat-label">Em Andamento</div></div>' +
            '<div class="stat-box red"><div class="stat-number">' + stats.atrasadas + '</div><div class="stat-label">Atrasadas</div></div>' +
            '<div class="stat-box purple"><div class="stat-number">' + progressoGeral + '%</div><div class="stat-label">Progresso</div></div>' +
            '</div>' +
            '<h3 style="color:#1f2937;border-bottom:2px solid #e5e7eb;padding-bottom:8px;margin-bottom:15px;">Lista de Tarefas</h3>' +
            '<table><thead><tr style="background-color:#1e40af;color:white;">' +
            '<th style="padding:10px;border:1px solid #1e40af;text-align:left;">Tarefa</th>' +
            '<th style="padding:10px;border:1px solid #1e40af;text-align:center;">Dias</th>' +
            '<th style="padding:10px;border:1px solid #1e40af;text-align:center;">Início</th>' +
            '<th style="padding:10px;border:1px solid #1e40af;text-align:center;">Término</th>' +
            '<th style="padding:10px;border:1px solid #1e40af;text-align:center;">Status</th>' +
            '<th style="padding:10px;border:1px solid #1e40af;text-align:center;">%</th>' +
            '<th style="padding:10px;border:1px solid #1e40af;text-align:left;">Responsável</th>' +
            '<th style="padding:10px;border:1px solid #1e40af;text-align:center;">Risco</th>' +
            '</tr></thead><tbody>' + tasksHtml + '</tbody></table>' +
            '<div style="margin-top:30px;padding-top:15px;border-top:1px solid #e5e7eb;text-align:center;color:#9ca3af;font-size:10px;"><p>Vinci Highways - Sistema de Gerenciamento de Projetos</p></div>' +
            '</body></html>';

        const printWindow = window.open('', '_blank', 'width=1200,height=800');
        printWindow.document.write(htmlContent);
        printWindow.document.close();

        printWindow.onload = function () {
            setTimeout(function () {
                printWindow.print();
                printWindow.onafterprint = function () {
                    printWindow.close();
                };
            }, 500);
        };

        uiService.showToast('Abrindo janela de impressão para PDF...');
    },
    exportMSProject: (project) => {
        if (!project) return uiService.showToast('Nenhum projeto selecionado.', 'error');

        const tasks = project.tasks || [];
        const today = new Date().toISOString();

        // 1. Função interna para organizar a hierarquia e calcular níveis (Igual ao PDF)
        const buildHierarchicalData = (tasksArray) => {
            const result = [];
            const processedIds = new Set();

            const normalizeId = (id) => (id === null || id === undefined || id === '') ? null : String(id);
            const isRootTask = (task) => task.parentId === null || task.parentId === undefined || task.parentId === '';

            const sortByDate = (a, b) => {
                const dateA = new Date(dataService.getLatestDates(a).startDate);
                const dateB = new Date(dataService.getLatestDates(b).startDate);
                return dateA - dateB;
            };

            // Recursivamente adiciona tarefas e calcula o nível (1, 2, 3...)
            const addTaskWithChildren = (task, level) => {
                const taskIdStr = normalizeId(task.id);
                if (taskIdStr !== null && processedIds.has(taskIdStr)) return;
                if (taskIdStr !== null) processedIds.add(taskIdStr);

                // Armazena a tarefa junto com seu nível hierárquico
                result.push({ task: task, level: level });

                const children = tasksArray.filter(t => {
                    const parentIdStr = normalizeId(t.parentId);
                    return parentIdStr !== null && taskIdStr !== null && parentIdStr === taskIdStr;
                });
                children.sort(sortByDate);
                children.forEach(child => addTaskWithChildren(child, level + 1));
            };

            const rootTasks = tasksArray.filter(isRootTask);
            rootTasks.sort(sortByDate);
            rootTasks.forEach(parent => addTaskWithChildren(parent, 1));

            // Captura tarefas órfãs (segurança)
            const orphans = tasksArray.filter(task => {
                const taskIdStr = normalizeId(task.id);
                return taskIdStr !== null && !processedIds.has(taskIdStr);
            });
            orphans.sort(sortByDate);
            orphans.forEach(task => {
                const taskIdStr = normalizeId(task.id);
                processedIds.add(taskIdStr);
                result.push({ task: task, level: 1 });
            });

            return result;
        };

        // 2. Obtém a lista já ordenada e com níveis definidos
        const sortedData = buildHierarchicalData(tasks);

        // 3. Gera o XML das tarefas na ordem correta
        let tasksXml = '';
        sortedData.forEach((item, index) => {
            const task = item.task;
            const level = item.level; // Nível calculado (1 = Principal, 2 = Subtarefa, etc)

            const latestDates = dataService.getLatestDates(task);
            const duration = reportService.calculateDuration(latestDates.startDate, latestDates.endDate);
            const msUID = index + 1; // UID sequencial para o MS Project não se perder
            const percentComplete = task.progress || 0;

            const priorityMap = { 'Alta': 700, 'Média': 500, 'Baixa': 300 };
            const priority = priorityMap[task.priority] || 500;

            // Verifica se é tarefa resumo (se tem filhos na lista original)
            const isSummary = tasks.some(t => t.parentId === task.id) ? 1 : 0;

            tasksXml += `
<Task>
    <UID>${msUID}</UID>
    <ID>${msUID}</ID>
    <Name>${(task.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Name>
    <Type>0</Type>
    <IsNull>0</IsNull>
    <CreateDate>${today}</CreateDate>
    <WBS>${msUID}</WBS>
    <OutlineNumber>${msUID}</OutlineNumber>
    <OutlineLevel>${level}</OutlineLevel>
    <Priority>${priority}</Priority>
    <Start>${latestDates.startDate}T08:00:00</Start>
    <Finish>${latestDates.endDate}T17:00:00</Finish>
    <Duration>PT${duration * 8}H0M0S</Duration>
    <ManualStart>${latestDates.startDate}T08:00:00</ManualStart>
    <ManualFinish>${latestDates.endDate}T17:00:00</ManualFinish>
    <ManualDuration>PT${duration * 8}H0M0S</ManualDuration>
    <DurationFormat>7</DurationFormat>
    <Work>PT${duration * 8}H0M0S</Work>
    <Stop>${latestDates.endDate}T17:00:00</Stop>
    <Resume>${latestDates.startDate}T08:00:00</Resume>
    <ResumeValid>0</ResumeValid>
    <EffortDriven>1</EffortDriven>
    <Recurring>0</Recurring>
    <OverAllocated>0</OverAllocated>
    <Estimated>0</Estimated>
    <Milestone>0</Milestone>
    <Summary>${isSummary}</Summary>
    <Critical>0</Critical>
    <IsSubproject>0</IsSubproject>
    <IsSubprojectReadOnly>0</IsSubprojectReadOnly>
    <ExternalTask>0</ExternalTask>
    <EarlyStart>${latestDates.startDate}T08:00:00</EarlyStart>
    <EarlyFinish>${latestDates.endDate}T17:00:00</EarlyFinish>
    <LateStart>${latestDates.startDate}T08:00:00</LateStart>
    <LateFinish>${latestDates.endDate}T17:00:00</LateFinish>
    <PercentComplete>${percentComplete}</PercentComplete>
    <PercentWorkComplete>${percentComplete}</PercentWorkComplete>
    <Cost>0</Cost>
    <OvertimeCost>0</OvertimeCost>
    <OvertimeWork>PT0H0M0S</OvertimeWork>
    <ActualStart>${task.status !== 'Não Iniciada' ? latestDates.startDate + 'T08:00:00' : ''}</ActualStart>
    <ActualDuration>PT${Math.round(duration * 8 * (percentComplete / 100))}H0M0S</ActualDuration>
    <ActualCost>0</ActualCost>
    <ActualOvertimeCost>0</ActualOvertimeCost>
    <ActualWork>PT${Math.round(duration * 8 * (percentComplete / 100))}H0M0S</ActualWork>
    <ActualOvertimeWork>PT0H0M0S</ActualOvertimeWork>
    <RegularWork>PT${duration * 8}H0M0S</RegularWork>
    <RemainingDuration>PT${Math.round(duration * 8 * ((100 - percentComplete) / 100))}H0M0S</RemainingDuration>
    <RemainingCost>0</RemainingCost>
    <RemainingWork>PT${Math.round(duration * 8 * ((100 - percentComplete) / 100))}H0M0S</RemainingWork>
    <RemainingOvertimeCost>0</RemainingOvertimeCost>
    <RemainingOvertimeWork>PT0H0M0S</RemainingOvertimeWork>
    <ConstraintType>0</ConstraintType>
    <CalendarUID>-1</CalendarUID>
    <LevelAssignments>1</LevelAssignments>
    <LevelingCanSplit>1</LevelingCanSplit>
    <LevelingDelay>0</LevelingDelay>
    <LevelingDelayFormat>8</LevelingDelayFormat>
    <IgnoreResourceCalendar>0</IgnoreResourceCalendar>
    <Notes>${task.risk ? 'TAREFA EM RISCO' : ''}</Notes>
    <HideBar>0</HideBar>
    <Rollup>0</Rollup>
    <BCWS>0</BCWS>
    <BCWP>0</BCWP>
    <PhysicalPercentComplete>0</PhysicalPercentComplete>
    <EarnedValueMethod>0</EarnedValueMethod>
    <IsPublished>1</IsPublished>
    <CommitmentType>0</CommitmentType>
</Task>`;
        });

        // 4. Monta o XML final
        const projectStart = tasks.length > 0
            ? new Date(Math.min(...tasks.map(t => new Date(dataService.getLatestDates(t).startDate)))).toISOString().split('T')[0] + 'T08:00:00'
            : today;

        const projectFinish = tasks.length > 0
            ? new Date(Math.max(...tasks.map(t => new Date(dataService.getLatestDates(t).endDate)))).toISOString().split('T')[0] + 'T17:00:00'
            : today;

        const xmlContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
    <SaveVersion>14</SaveVersion>
    <BuildNumber>14.0</BuildNumber>
    <Name>${(project.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Name>
    <Title>${(project.name || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Title>
    <Company>Vinci Highways</Company>
    <Author>Sistema de Gerenciamento de Projetos</Author>
    <CreationDate>${today}</CreationDate>
    <LastSaved>${today}</LastSaved>
    <ScheduleFromStart>1</ScheduleFromStart>
    <StartDate>${projectStart}</StartDate>
    <FinishDate>${projectFinish}</FinishDate>
    <FYStartDate>1</FYStartDate>
    <CriticalSlackLimit>0</CriticalSlackLimit>
    <CurrencyDigits>2</CurrencyDigits>
    <CurrencySymbol>R$</CurrencySymbol>
    <CurrencyCode>BRL</CurrencyCode>
    <CurrencySymbolPosition>0</CurrencySymbolPosition>
    <CalendarUID>1</CalendarUID>
    <DefaultStartTime>08:00:00</DefaultStartTime>
    <DefaultFinishTime>17:00:00</DefaultFinishTime>
    <MinutesPerDay>480</MinutesPerDay>
    <MinutesPerWeek>2400</MinutesPerWeek>
    <DaysPerMonth>20</DaysPerMonth>
    <DefaultTaskType>0</DefaultTaskType>
    <DefaultFixedCostAccrual>3</DefaultFixedCostAccrual>
    <DefaultStandardRate>0</DefaultStandardRate>
    <DefaultOvertimeRate>0</DefaultOvertimeRate>
    <DurationFormat>7</DurationFormat>
    <WorkFormat>2</WorkFormat>
    <EditableActualCosts>0</EditableActualCosts>
    <HonorConstraints>0</HonorConstraints>
    <InsertedProjectsLikeSummary>1</InsertedProjectsLikeSummary>
    <MultipleCriticalPaths>0</MultipleCriticalPaths>
    <NewTasksEffortDriven>1</NewTasksEffortDriven>
    <NewTasksEstimated>1</NewTasksEstimated>
    <SplitsInProgressTasks>1</SplitsInProgressTasks>
    <SpreadActualCost>0</SpreadActualCost>
    <SpreadPercentComplete>0</SpreadPercentComplete>
    <TaskUpdatesResource>1</TaskUpdatesResource>
    <FiscalYearStart>0</FiscalYearStart>
    <WeekStartDay>1</WeekStartDay>
    <MoveCompletedEndsBack>0</MoveCompletedEndsBack>
    <MoveRemainingStartsBack>0</MoveRemainingStartsBack>
    <MoveRemainingStartsForward>0</MoveRemainingStartsForward>
    <MoveCompletedEndsForward>0</MoveCompletedEndsForward>
    <BaselineForEarnedValue>0</BaselineForEarnedValue>
    <AutoAddNewResourcesAndTasks>1</AutoAddNewResourcesAndTasks>
    <CurrentDate>${today}</CurrentDate>
    <MicrosoftProjectServerURL>1</MicrosoftProjectServerURL>
    <Autolink>1</Autolink>
    <NewTaskStartDate>0</NewTaskStartDate>
    <DefaultTaskEVMethod>0</DefaultTaskEVMethod>
    <ProjectExternallyEdited>0</ProjectExternallyEdited>
    <ExtendedCreationDate>${today}</ExtendedCreationDate>
    <ActualsInSync>1</ActualsInSync>
    <RemoveFileProperties>0</RemoveFileProperties>
    <AdminProject>0</AdminProject>
    <Calendars>
<Calendar>
    <UID>1</UID>
    <Name>Standard</Name>
    <IsBaseCalendar>1</IsBaseCalendar>
    <BaseCalendarUID>-1</BaseCalendarUID>
    <WeekDays>
        <WeekDay>
            <DayType>1</DayType>
            <DayWorking>0</DayWorking>
        </WeekDay>
        <WeekDay>
            <DayType>2</DayType>
            <DayWorking>1</DayWorking>
            <WorkingTimes>
                <WorkingTime>
                    <FromTime>08:00:00</FromTime>
                    <ToTime>12:00:00</ToTime>
                </WorkingTime>
                <WorkingTime>
                    <FromTime>13:00:00</FromTime>
                    <ToTime>17:00:00</ToTime>
                </WorkingTime>
            </WorkingTimes>
        </WeekDay>
        <WeekDay>
            <DayType>3</DayType>
            <DayWorking>1</DayWorking>
            <WorkingTimes>
                <WorkingTime>
                    <FromTime>08:00:00</FromTime>
                    <ToTime>12:00:00</ToTime>
                </WorkingTime>
                <WorkingTime>
                    <FromTime>13:00:00</FromTime>
                    <ToTime>17:00:00</ToTime>
                </WorkingTime>
            </WorkingTimes>
        </WeekDay>
        <WeekDay>
            <DayType>4</DayType>
            <DayWorking>1</DayWorking>
            <WorkingTimes>
                <WorkingTime>
                    <FromTime>08:00:00</FromTime>
                    <ToTime>12:00:00</ToTime>
                </WorkingTime>
                <WorkingTime>
                    <FromTime>13:00:00</FromTime>
                    <ToTime>17:00:00</ToTime>
                </WorkingTime>
            </WorkingTimes>
        </WeekDay>
        <WeekDay>
            <DayType>5</DayType>
            <DayWorking>1</DayWorking>
            <WorkingTimes>
                <WorkingTime>
                    <FromTime>08:00:00</FromTime>
                    <ToTime>12:00:00</ToTime>
                </WorkingTime>
                <WorkingTime>
                    <FromTime>13:00:00</FromTime>
                    <ToTime>17:00:00</ToTime>
                </WorkingTime>
            </WorkingTimes>
        </WeekDay>
        <WeekDay>
            <DayType>6</DayType>
            <DayWorking>1</DayWorking>
            <WorkingTimes>
                <WorkingTime>
                    <FromTime>08:00:00</FromTime>
                    <ToTime>12:00:00</ToTime>
                </WorkingTime>
                <WorkingTime>
                    <FromTime>13:00:00</FromTime>
                    <ToTime>17:00:00</ToTime>
                </WorkingTime>
            </WorkingTimes>
        </WeekDay>
        <WeekDay>
            <DayType>7</DayType>
            <DayWorking>0</DayWorking>
        </WeekDay>
    </WeekDays>
</Calendar>
    </Calendars>
    <Tasks>${tasksXml}
    </Tasks>
</Project>`;

        const blob = new Blob([xmlContent], { type: 'application/xml' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `${project.name}.xml`;
        link.click();
        URL.revokeObjectURL(link.href);

        uiService.showToast('Exportado para Microsoft Project (XML) com sucesso! Abra o arquivo no MS Project.', 'success');
    },
    downloadExcelTemplate: () => {
        const template = [
            {
                'Tarefa': 'Nome da tarefa',
                'Data Início': '2024-01-01',
                'Data Termino': '2024-01-05',
                'Status': 'Não Iniciada',
                'Progresso (%)': 0,
                'Prioridade': 'Média',
                'Atribuído a (Nomes Separados por Vírgula)': 'nome1, nome2',
                'Risco (Sim/Nao)': 'Nao',
                'Tarefa Pai (Nome)': 'Nome da tarefa pai (opcional)'
            }
        ];
        const worksheet = XLSX.utils.json_to_sheet(template);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Template');
        XLSX.writeFile(workbook, 'template_importacao_tarefas.xlsx');
        uiService.showToast('Template baixado com sucesso!');
    }
};

// EXPOSE SERVICES TO WINDOW for onclick handlers in dynamically generated HTML
window.uiService = uiService;
window.dataService = dataService;

// Initialize the application
document.addEventListener('DOMContentLoaded', () => App.init());
